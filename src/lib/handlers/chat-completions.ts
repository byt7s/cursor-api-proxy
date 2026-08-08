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
import { getAccountStats } from "../account-pool.js";
import {
  ALL_ACCOUNTS_DISABLED_MESSAGE,
  ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
  runStreamWithAccountFailover,
  runSyncWithAccountFailover,
} from "../account-failover.js";
import { abortOnClientDisconnect } from "../client-disconnect.js";
import {
  fitPromptToWinCmdline,
  warnPromptTruncated,
} from "../win-cmdline-limit.js";

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
    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);
    res.on("error", () => {
      /* client disconnected mid-stream */
    });

    let headersWritten = false;
    const ensureHeaders = () => {
      if (!headersWritten) {
        headersWritten = true;
        writeSseHeaders(res, truncatedHeaders);
      }
    };

    const writeChatChunk = (content: string) => {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: displayModel,
          choices: [
            { index: 0, delta: { content }, finish_reason: null },
          ],
        })}\n\n`,
      );
    };

    const finishChatStream = (accumulated: string) => {
      logTrafficResponse(
        config.verbose,
        model ?? cursorModel,
        accumulated,
        true,
      );
      const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
      const completionTokens = Math.max(1, Math.round(accumulated.length / 4));
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
    };

    if (config.useAcp && typeof promptForAgent === "string") {
      let accumulated = "";
      try {
        const outcome = await runStreamWithAccountFailover({
          signal: abortController.signal,
          onCommit: ensureHeaders,
          onChunk: (chunk) => {
            accumulated += chunk;
            writeChatChunk(chunk);
          },
          runOnce: (configDir, onChunk) =>
            runAgentStream(
              config,
              workspaceDir,
              effectiveChatOnly,
              cmdArgs,
              onChunk,
              tempDir,
              promptForAgent,
              configDir,
              abortController.signal,
            ),
        });

        if (outcome.status === "aborted") {
          if (headersWritten) res.end();
          return;
        }

        if (outcome.status === "all_rate_limited") {
          if (!headersWritten) {
            json(res, 429, {
              error: {
                message: ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
                code: "rate_limit_exceeded",
              },
            });
          } else {
            res.write(
              `data: ${JSON.stringify({
                error: {
                  message: ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
                  code: "rate_limit_exceeded",
                },
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }
          logAccountStats(config.verbose, getAccountStats());
          return;
        }

        if (outcome.status === "all_disabled") {
          if (!headersWritten) {
            json(res, 403, {
              error: {
                message: ALL_ACCOUNTS_DISABLED_MESSAGE,
                code: "no_usable_accounts",
              },
            });
          } else {
            res.write(
              `data: ${JSON.stringify({
                error: {
                  message: ALL_ACCOUNTS_DISABLED_MESSAGE,
                  code: "no_usable_accounts",
                },
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }
          logAccountStats(config.verbose, getAccountStats());
          return;
        }

        if (outcome.status === "error") {
          ensureHeaders();
          const publicMsg = logAgentError(
            config.sessionsLogPath,
            method,
            pathname,
            remoteAddress,
            outcome.code,
            outcome.stderr,
          );
          res.write(
            `data: ${JSON.stringify({
              error: { message: publicMsg, code: "cursor_cli_error" },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          logAccountStats(config.verbose, getAccountStats());
          res.end();
          return;
        }

        ensureHeaders();
        finishChatStream(accumulated);
        logAccountStats(config.verbose, getAccountStats());
        res.end();
      } catch (err) {
        if (!abortController.signal.aborted) {
          ensureHeaders();
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
        if (headersWritten) res.end();
      }
      return;
    }

    let accumulated = "";
    try {
      const outcome = await runStreamWithAccountFailover({
        signal: abortController.signal,
        onCommit: ensureHeaders,
        onChunk: (text) => {
          accumulated += text;
          writeChatChunk(text);
        },
        runOnce: (configDir, onChunk) => {
          const parseLine = createStreamParser(onChunk, () => {
            /* finish written after successful failover outcome */
          });
          return runAgentStream(
            config,
            workspaceDir,
            effectiveChatOnly,
            cmdArgs,
            parseLine,
            tempDir,
            promptForAgent,
            configDir,
            abortController.signal,
          );
        },
      });

      if (outcome.status === "aborted") {
        if (headersWritten) res.end();
        return;
      }

      if (outcome.status === "all_rate_limited") {
        if (!headersWritten) {
          json(res, 429, {
            error: {
              message: ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
              code: "rate_limit_exceeded",
            },
          });
        } else {
          res.end();
        }
        logAccountStats(config.verbose, getAccountStats());
        return;
      }

      if (outcome.status === "all_disabled") {
        if (!headersWritten) {
          json(res, 403, {
            error: {
              message: ALL_ACCOUNTS_DISABLED_MESSAGE,
              code: "no_usable_accounts",
            },
          });
        } else {
          res.end();
        }
        logAccountStats(config.verbose, getAccountStats());
        return;
      }

      if (outcome.status === "error") {
        logAgentError(
          config.sessionsLogPath,
          method,
          pathname,
          remoteAddress,
          outcome.code,
          outcome.stderr,
        );
        if (!headersWritten) {
          json(res, 500, {
            error: {
              message:
                "The Cursor agent process failed. See server logs for details.",
              code: "cursor_cli_error",
            },
          });
        } else {
          res.end();
        }
        logAccountStats(config.verbose, getAccountStats());
        return;
      }

      ensureHeaders();
      finishChatStream(accumulated);
      logAccountStats(config.verbose, getAccountStats());
      res.end();
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] Agent stream error:`,
        err,
      );
      if (headersWritten) res.end();
    }
    return;
  }

  const abortController = new AbortController();
  abortOnClientDisconnect(res, abortController);

  const outcome = await runSyncWithAccountFailover(
    (configDir) =>
      runAgentSync(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        tempDir,
        promptForAgent,
        configDir,
        abortController.signal,
      ),
    abortController.signal,
  );

  if (outcome.status === "aborted") {
    return;
  }

  if (outcome.status === "all_rate_limited") {
    logAccountStats(config.verbose, getAccountStats());
    if (outcome.result) {
      logAgentError(
        config.sessionsLogPath,
        method,
        pathname,
        remoteAddress,
        outcome.result.code,
        outcome.result.stderr ?? "",
      );
    }
    json(res, 429, {
      error: {
        message: ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
        code: "rate_limit_exceeded",
      },
    });
    return;
  }

  if (outcome.status === "all_disabled") {
    logAccountStats(config.verbose, getAccountStats());
    json(res, 403, {
      error: {
        message: ALL_ACCOUNTS_DISABLED_MESSAGE,
        code: "no_usable_accounts",
      },
    });
    return;
  }

  if (outcome.status === "error") {
    logAccountStats(config.verbose, getAccountStats());
    const errMsg = logAgentError(
      config.sessionsLogPath,
      method,
      pathname,
      remoteAddress,
      outcome.result.code,
      outcome.result.stderr ?? "",
    );
    json(res, 500, {
      error: { message: errMsg, code: "cursor_cli_error" },
    });
    return;
  }

  const content = (outcome.result.stdout ?? "").trim();
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);

  const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
  const completionTokens = Math.max(1, Math.round(content.length / 4));
  const totalTokens = promptTokens + completionTokens;

  logAccountStats(config.verbose, getAccountStats());
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
    truncatedHeaders,
  );
}
