import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import type { ModelCacheRef } from "./models.js";
import { getCachedCursorModels } from "./models.js";
import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { createStreamParser } from "../cli-stream-parser.js";
import { json, writeSseHeaders } from "../http.js";
import { resolveModelForExecution } from "../model-map.js";
import {
  buildPromptFromMessages,
  normalizeModelId,
  toolsToSystemText,
  type OpenAiChatCompletionRequest,
} from "../openai.js";
import {
  logAgentError,
  logAccountAssigned,
  logAccountStats,
  logModelResolution,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../request-log.js";
import { rememberResolvedModel, resolveModel } from "../resolve-model.js";
import { resolveRequestMode } from "../resolve-mode.js";
import { resolveWorkspace } from "../workspace.js";
import { buildBridgeContextPreamble, BRIDGE_AGENT_PROMPT_SEPARATOR } from "../bridge-context-preamble.js";
import { sanitizeMessages } from "../sanitize.js";
import {
  getNextAccountConfigDir,
  reportRequestStart,
  reportRequestEnd,
  reportRateLimit,
  reportRequestSuccess,
  reportRequestError,
  getAccountStats,
} from "../account-pool.js";
import { abortOnClientDisconnect } from "../client-disconnect.js";
import {
  fitPromptToWinCmdline,
  warnPromptTruncated,
} from "../win-cmdline-limit.js";
import { LatencyWaterfall } from "../latency-waterfall.js";

function isRateLimited(stderr: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(stderr);
}

function logLatency(
  config: BridgeConfig,
  latency: LatencyWaterfall,
  extra?: Record<string, unknown>,
): void {
  if (!config.latencyWaterfall) return;
  latency.logLine(extra);
}

/** Approximate ACP/CLI ready → first token when finer agent marks are unavailable. */
function markModelFirstByte(latency: LatencyWaterfall): void {
  if (latency.has("model_first_byte")) return;
  if (!latency.has("spawn_ready")) latency.mark("spawn_ready");
  if (!latency.has("session_ready")) latency.mark("session_ready");
  latency.mark("model_first_byte");
}

export type ChatCompletionsCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
  modelCacheRef: ModelCacheRef;
};

export async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ChatCompletionsCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const latency = new LatencyWaterfall();
  const { config, lastRequestedModelRef, modelCacheRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as OpenAiChatCompletionRequest;
  const requested = normalizeModelId(body.model);
  const model = resolveModel(requested, lastRequestedModelRef, config);
  const models = await getCachedCursorModels(config, modelCacheRef);
  const decision = resolveModelForExecution({
    requested: model,
    defaultModel: config.defaultModel,
    availableCursorIds: models.map((m) => m.id),
  });
  const cursorModel = decision.final;
  rememberResolvedModel(cursorModel, lastRequestedModelRef);
  logModelResolution(config.verbose, decision);
  // When request is "default", use defaultModel for response display (dashboard) if set; else echo "default"
  const displayModel =
    decision.requestedWasDefault && config.defaultModel !== "default"
      ? config.defaultModel
      : model;

  const cleanMessages = sanitizeMessages(body.messages ?? []);

  const toolsText = toolsToSystemText(body.tools, body.functions);
  const messagesWithTools = toolsText
    ? [{ role: "system", content: toolsText }, ...cleanMessages]
    : cleanMessages;
  const prompt = buildPromptFromMessages(messagesWithTools);

  const trafficMessages: TrafficMessage[] = cleanMessages.map((m: any) => {
    const content =
      typeof m?.content === "string"
        ? m.content
        : Array.isArray(m?.content)
          ? (m.content as Array<{ type?: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("")
          : "";
    return { role: String(m?.role ?? "user"), content };
  });
  logTrafficRequest(
    config.verbose,
    model ?? cursorModel,
    trafficMessages,
    !!body.stream,
  );

  let mode: CursorExecutionMode;
  try {
    mode = resolveRequestMode(
      config,
      req.headers["x-cursor-mode"],
      body.mode,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid mode";
    json(res, 400, { error: { message: msg, code: "invalid_mode" } });
    return;
  }

  const effectiveChatOnly =
    mode === "ask"
      ? config.chatOnlyWorkspace
      : config.chatOnlyWorkspaceExplicit && config.chatOnlyWorkspace;

  const headerWs = req.headers["x-cursor-workspace"];
  let workspaceDir: string;
  let tempDir: string | undefined;
  try {
    const ws = resolveWorkspace(config, headerWs, effectiveChatOnly);
    workspaceDir = ws.workspaceDir;
    tempDir = ws.tempDir;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid workspace";
    json(res, 400, { error: { message: msg, code: "invalid_workspace" } });
    return;
  }

  const agentPrompt = config.contextPreamble
    ? `${buildBridgeContextPreamble({
        headers: req.headers,
        bridgeWorkspaceBase: config.workspace,
        agentWorkspaceDir: workspaceDir,
        isolatedChatOnly: tempDir !== undefined,
        cursorMode: mode,
        contextExtra: config.contextExtra,
      })}${BRIDGE_AGENT_PROMPT_SEPARATOR}${prompt}`
    : prompt;

  const fixedArgs = buildAgentFixedArgs(
    config,
    workspaceDir,
    cursorModel,
    !!body.stream,
    mode,
    effectiveChatOnly,
  );
  const fit = fitPromptToWinCmdline(config.agentBin, fixedArgs, agentPrompt, {
    maxCmdline: config.winCmdlineMax,
    platform: process.platform,
    cwd: workspaceDir,
  });
  if (!fit.ok) {
    json(res, 500, {
      error: {
        message: fit.error,
        code: "windows_cmdline_limit",
        type: "api_error",
      },
    });
    return;
  }
  if (fit.truncated) {
    warnPromptTruncated(fit.originalLength, fit.finalPromptLength);
  }
  // When the prompt is delivered via stdin (or ACP), keep it OUT of argv,
  // otherwise a long prompt still blows past the kernel ARG_MAX (spawn E2BIG
  // on Linux). fit.args appends the full prompt for the argv path only.
  const cmdArgs =
    config.promptViaStdin || config.useAcp ? fixedArgs : fit.args;

  const id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  const promptForAgent =
    config.promptViaStdin || config.useAcp ? agentPrompt : undefined;

  const truncatedHeaders = fit.truncated
    ? { "X-Cursor-Proxy-Prompt-Truncated": "true" }
    : undefined;

  if (body.stream) {
    latency.mark("exec_start");
    latency.mark("account_select_start");
    const configDir = getNextAccountConfigDir();
    latency.mark("account_select_end");
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const streamStart = Date.now();

    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);

    writeSseHeaders(res, truncatedHeaders);
    res.on("error", () => {
      /* client disconnected mid-stream */
    });

    if (config.useAcp && typeof promptForAgent === "string") {
      let accumulated = "";
      latency.mark("spawn_start");
      runAgentStream(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        (chunk) => {
          markModelFirstByte(latency);
          accumulated += chunk;
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: displayModel,
              choices: [
                { index: 0, delta: { content: chunk }, finish_reason: null },
              ],
            })}\n\n`,
          );
        },
        tempDir,
        promptForAgent,
        configDir,
        abortController.signal,
      )
        .then(({ code, stderr: stderrOut }) => {
          const latencyMs = Date.now() - streamStart;
          reportRequestEnd(configDir);

          if (stderrOut && isRateLimited(stderrOut)) {
            reportRateLimit(configDir, 60000);
          }

          if (abortController.signal.aborted) {
            latency.mark("shape_done");
            logLatency(config, latency, {
              ok: false,
              aborted: true,
              model: displayModel,
            });
            /* client disconnected — do not count as success or failure */
          } else if (code !== 0) {
            reportRequestError(configDir, latencyMs);
            const publicMsg = logAgentError(
              config.sessionsLogPath,
              method,
              pathname,
              remoteAddress,
              code,
              stderrOut,
            );
            res.write(
              `data: ${JSON.stringify({
                error: { message: publicMsg, code: "cursor_cli_error" },
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            logAccountStats(config.verbose, getAccountStats());
            latency.mark("shape_done");
            logLatency(config, latency, { ok: false, model: displayModel });
            res.end();
            return;
          } else {
            reportRequestSuccess(configDir, latencyMs);
          }
          if (!latency.has("model_complete")) latency.mark("model_complete");
          logAccountStats(config.verbose, getAccountStats());
          logTrafficResponse(
            config.verbose,
            model ?? cursorModel,
            accumulated,
            true,
          );
          const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
          const completionTokens = Math.max(
            1,
            Math.round(accumulated.length / 4),
          );
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: displayModel,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          latency.mark("shape_done");
          logLatency(config, latency, { ok: true, model: displayModel });
          res.end();
        })
        .catch((err) => {
          reportRequestEnd(configDir);
          if (!abortController.signal.aborted) {
            reportRequestError(configDir, Date.now() - streamStart);
            res.write(
              `data: ${JSON.stringify({
                error: {
                  message:
                    "The Cursor agent stream failed. See server logs for details.",
                  code: "cursor_cli_error",
                },
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
          }
          console.error(
            `[${new Date().toISOString()}] Agent stream error:`,
            err,
          );
          latency.mark("shape_done");
          logLatency(config, latency, { ok: false, model: displayModel });
          res.end();
        });
      return;
    }

    let accumulated = "";
    const parseLine = createStreamParser(
      (text) => {
        markModelFirstByte(latency);
        accumulated += text;
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: displayModel,
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          })}\n\n`,
        );
      },
      () => {
        if (!latency.has("model_complete")) latency.mark("model_complete");
        logTrafficResponse(
          config.verbose,
          model ?? cursorModel,
          accumulated,
          true,
        );
        const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
        const completionTokens = Math.max(
          1,
          Math.round(accumulated.length / 4),
        );
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: displayModel,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        latency.mark("shape_done");
        logLatency(config, latency, { ok: true, model: displayModel });
      },
    );

    latency.mark("spawn_start");
    runAgentStream(
      config,
      workspaceDir,
      effectiveChatOnly,
      cmdArgs,
      parseLine,
      tempDir,
      promptForAgent,
      configDir,
      abortController.signal,
    )
      .then(({ code, stderr: stderrOut }) => {
        const latencyMs = Date.now() - streamStart;
        reportRequestEnd(configDir);

        if (stderrOut && isRateLimited(stderrOut)) {
          reportRateLimit(configDir, 60000);
        }

        if (abortController.signal.aborted) {
          /* client disconnected — do not count as success or failure */
        } else if (code !== 0) {
          reportRequestError(configDir, latencyMs);
          logAgentError(
            config.sessionsLogPath,
            method,
            pathname,
            remoteAddress,
            code,
            stderrOut,
          );
          if (!latency.has("shape_done")) {
            latency.mark("shape_done");
            logLatency(config, latency, { ok: false, model: displayModel });
          }
        } else {
          reportRequestSuccess(configDir, latencyMs);
          if (!latency.has("shape_done")) {
            if (!latency.has("model_complete")) latency.mark("model_complete");
            latency.mark("shape_done");
            logLatency(config, latency, { ok: true, model: displayModel });
          }
        }
        logAccountStats(config.verbose, getAccountStats());
        res.end();
      })
      .catch((err) => {
        reportRequestEnd(configDir);
        if (!abortController.signal.aborted) {
          reportRequestError(configDir, Date.now() - streamStart);
        }
        console.error(
          `[${new Date().toISOString()}] Agent stream error:`,
          err,
        );
        latency.mark("shape_done");
        logLatency(config, latency, { ok: false, model: displayModel });
        res.end();
      });
    return;
  }

  latency.mark("exec_start");
  latency.mark("account_select_start");
  const configDir = getNextAccountConfigDir();
  latency.mark("account_select_end");
  logAccountAssigned(configDir);
  reportRequestStart(configDir);
  const syncStart = Date.now();

  const abortController = new AbortController();
  abortOnClientDisconnect(res, abortController);

  latency.mark("spawn_start");
  const out = await runAgentSync(
    config,
    workspaceDir,
    effectiveChatOnly,
    cmdArgs,
    tempDir,
    promptForAgent,
    configDir,
    abortController.signal,
  );
  if (!latency.has("spawn_ready")) latency.mark("spawn_ready");
  if (!latency.has("session_ready")) latency.mark("session_ready");
  if (!latency.has("model_first_byte")) latency.mark("model_first_byte");
  const syncLatency = Date.now() - syncStart;
  reportRequestEnd(configDir);

  if (out.stderr && isRateLimited(out.stderr)) {
    reportRateLimit(configDir, 60000);
  }

  if (out.code !== 0) {
    reportRequestError(configDir, syncLatency);
    logAccountStats(config.verbose, getAccountStats());
    const errMsg = logAgentError(
      config.sessionsLogPath,
      method,
      pathname,
      remoteAddress,
      out.code,
      out.stderr,
    );
    latency.mark("shape_done");
    logLatency(config, latency, { ok: false, model: displayModel });
    json(
      res,
      500,
      {
        error: { message: errMsg, code: "cursor_cli_error" },
      },
      config.latencyWaterfall
        ? { "X-Cursor-Proxy-Waterfall": latency.headerValue() }
        : undefined,
    );
    return;
  }

  reportRequestSuccess(configDir, syncLatency);
  if (!latency.has("model_complete")) latency.mark("model_complete");
  const content = out.stdout.trim();
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);

  const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
  const completionTokens = Math.max(1, Math.round(content.length / 4));
  const totalTokens = promptTokens + completionTokens;

  latency.mark("shape_done");
  logLatency(config, latency, { ok: true, model: displayModel });
  logAccountStats(config.verbose, getAccountStats());
  const extraHeaders = {
    ...(truncatedHeaders ?? {}),
    ...(config.latencyWaterfall
      ? { "X-Cursor-Proxy-Waterfall": latency.headerValue() }
      : {}),
  };
  json(
    res,
    200,
    {
      id,
      object: "chat.completion",
      created,
      model: displayModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    },
    Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
  );
}
