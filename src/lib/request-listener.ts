import * as fs from "node:fs";
import * as http from "node:http";

import {
  apiKeyFingerprint,
  buildApiKeyRegistry,
  matchApiKey,
} from "./api-keys.js";
import type { BridgeConfig } from "./config.js";
import { applyCors } from "./cors.js";
import { consumeKeyRateLimit } from "./key-rate-limit.js";
import type { ModelCacheRef } from "./handlers/models.js";
import { handleHealth } from "./handlers/health.js";
import { handleModels } from "./handlers/models.js";
import { handleChatCompletions } from "./handlers/chat-completions.js";
import { handleResponses } from "./handlers/responses.js";
import { handleAnthropicMessages } from "./handlers/anthropic-messages.js";
import { handleAccounts } from "./handlers/accounts.js";
import {
  adminDashboardMatches,
  handleAdminDashboard,
} from "./admin-dashboard.js";
import { handleMetrics, METRICS_PATH } from "./handlers/metrics.js";
import {
  BodyTooLargeError,
  extractBearerToken,
  json,
  readBody,
} from "./http.js";
import { observeRequest } from "./metrics.js";
import { appendSessionLine, logIncoming } from "./request-log.js";
import {
  appendRequestRecord,
  buildRequestRecord,
  getRequestAnnotation,
} from "./request-record.js";

export type BridgeServerOptions = {
  version: string;
  config: BridgeConfig;
};

export function createRequestListener(opts: BridgeServerOptions) {
  const { config } = opts;
  const modelCacheRef: ModelCacheRef = { current: undefined };
  const lastRequestedModelRef: { current?: string } = {};
  // `loadEnvConfig` already folds the legacy key into `apiKeys`; configs built
  // by hand (tests, embedders) may only carry `requiredKey`.
  const inboundKeys =
    config.apiKeys.length > 0
      ? config.apiKeys
      : buildApiKeyRegistry(config.requiredKey, []);

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const protocol = config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
    const url = new URL(
      req.url || "/",
      `${protocol}://${req.headers.host || "localhost"}`,
    );
    const remoteAddress = req.socket?.remoteAddress ?? "unknown";
    const method = req.method ?? "?";
    const pathname = url.pathname;

    // Skip request logging for the admin dashboard's own traffic
    // (status/log/stats polls, asset loads, control actions). These are
    // self-referential noise that pollutes the live log tail the dashboard
    // reads from the sessions log file.
    const isAdminDashboardReq = adminDashboardMatches(req);
    const isMetricsReq = req.method === "GET" && pathname === METRICS_PATH;

    // Dashboard polls and metrics scrapes are self-referential noise: they stay
    // out of both request logs and out of the request counters.
    if (!isAdminDashboardReq && !isMetricsReq) {
      const startedAt = Date.now();
      logIncoming(method, pathname, remoteAddress);
      res.on("finish", () => {
        appendSessionLine(
          config.sessionsLogPath,
          method,
          pathname,
          remoteAddress,
          res.statusCode,
        );
        const record = buildRequestRecord({
          method,
          pathname,
          remoteAddress,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          annotation: getRequestAnnotation(res),
        });
        appendRequestRecord(record, {
          enabled: config.requestsLogEnabled,
          logPath: config.requestsLogPath,
          maxBytes: config.requestsLogMaxBytes,
        });
        observeRequest({
          route: record.pathname,
          status: record.status,
          model: record.model,
          engine: record.engine,
          account: record.account,
          durationMs: record.durationMs,
          spans: record.spans,
        });
      });
    }

    try {
      // CORS headers (when configured) must be attached before any handler
      // writes, and a preflight never reaches the auth gate.
      if (applyCors(req, res, config.corsOrigins).preflightHandled) return;

      if (req.method === "GET" && pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok\n");
        return;
      }

      if (isMetricsReq) {
        handleMetrics(req, res, opts);
        return;
      }

      if (isAdminDashboardReq) {
        handleAdminDashboard(req, res, opts);
        return;
      }

      // Any configured key (chat or admin scope) reaches the LLM routes; the
      // per-key limit only applies once we know which key is calling.
      if (inboundKeys.length > 0) {
        const matched = matchApiKey(inboundKeys, extractBearerToken(req));
        if (!matched) {
          json(res, 401, {
            error: { message: "Invalid API key", code: "unauthorized" },
          });
          return;
        }
        const decision = consumeKeyRateLimit(
          apiKeyFingerprint(matched.key),
          config.keyRateLimitPerMin,
        );
        if (!decision.allowed) {
          json(
            res,
            429,
            {
              error: {
                message: `Rate limit of ${config.keyRateLimitPerMin} requests/min exceeded for key "${matched.label}"`,
                code: "rate_limited",
              },
            },
            { "Retry-After": String(decision.retryAfterSeconds) },
          );
          return;
        }
      }

      if (req.method === "GET" && pathname === "/health") {
        handleHealth(res, { version: opts.version, config });
        return;
      }

      if (req.method === "GET" && pathname === "/accounts") {
        handleAccounts(res);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/models") {
        await handleModels(res, { config, modelCacheRef });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/chat/completions") {
        const raw = await readBody(req, config.maxBodyBytes);
        await handleChatCompletions(
          req,
          res,
          { config, lastRequestedModelRef, modelCacheRef },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (req.method === "POST" && pathname === "/v1/responses") {
        const raw = await readBody(req, config.maxBodyBytes);
        await handleResponses(
          req,
          res,
          { config, lastRequestedModelRef, modelCacheRef },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (req.method === "POST" && pathname === "/v1/messages") {
        const raw = await readBody(req, config.maxBodyBytes);
        await handleAnthropicMessages(
          req,
          res,
          { config, lastRequestedModelRef, modelCacheRef },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (
        (req.method === "POST" || req.method === "GET") &&
        pathname === "/v1/completions"
      ) {
        json(res, 404, {
          error: {
            message:
              "Legacy completions endpoint is not supported. Use POST /v1/chat/completions instead.",
            code: "not_found",
          },
        });
      } else if (pathname === "/v1/embeddings") {
        json(res, 404, {
          error: {
            message: "Embeddings are not supported by this proxy.",
            code: "not_found",
          },
        });
      } else {
        json(res, 404, { error: { message: "Not found", code: "not_found" } });
      }
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        if (!res.headersSent) {
          json(res, 413, {
            error: {
              message: `${err.message} (CURSOR_BRIDGE_MAX_BODY_BYTES)`,
              code: "payload_too_large",
              maxBytes: err.maxBytes,
            },
          });
        } else {
          res.end();
        }
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${new Date().toISOString()}] Proxy error: ${msg}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      try {
        fs.appendFileSync(
          config.sessionsLogPath,
          `${new Date().toISOString()} ERROR ${method} ${pathname} ${remoteAddress} ${msg.slice(0, 200).replace(/\n/g, " ")}\n`,
        );
      } catch {
        /* ignore */
      }
      if (!res.headersSent) {
        json(res, 500, {
          error: { message: msg, code: "internal_error" },
        });
      } else {
        res.end();
      }
    }
  };
}
