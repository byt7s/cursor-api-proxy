import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import type { ModelCacheRef } from "./models.js";
import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import {
  AdmissionCapacityError,
  AGENT_CAPACITY_MESSAGE,
} from "../admission.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { createStreamParser } from "../cli-stream-parser.js";
import { json, writeSseHeaders } from "../http.js";
import { resolveModelWithoutCatalog } from "../model-map.js";
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
import { LatencyWaterfall } from "../latency-waterfall.js";
import {
  thoughtStreamDelta,
  withReasoningContent,
} from "../thought-mode.js";
import {
  buildBufferedStreamChunks,
  buildToolBridgeSystemText,
  containsToolCallCandidate,
  parseToolCallOutput,
  resolveAssistantOutput,
  shouldUseToolBridge,
} from "../tool-calls.js";

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
  const { config, lastRequestedModelRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as OpenAiChatCompletionRequest;
  const requested = normalizeModelId(body.model);
  const model = resolveModel(requested, lastRequestedModelRef, config);
  // Skip agent --list-models on the hot path (~2s); GET /v1/models still lists.
  const decision = resolveModelWithoutCatalog({
    requested: model,
    defaultModel: config.defaultModel,
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

  const toolBridgeActive =
    config.toolCalls && shouldUseToolBridge(body.tools, body.tool_choice);
  const toolsText = config.toolCalls
    ? toolBridgeActive
      ? buildToolBridgeSystemText(body.tools, body.tool_choice)
      : undefined
    : toolsToSystemText(body.tools, body.functions);
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
      {
        hasTools:
          (Array.isArray(body.tools) && body.tools.length > 0) ||
          (Array.isArray(body.functions) && body.functions.length > 0),
      },
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
      markModelFirstByte(latency);
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

    const usageFor = (promptText: string, completionText: string) => {
      const promptTokens = Math.max(1, Math.round(promptText.length / 4));
      const completionTokens = Math.max(
        1,
        Math.round(completionText.length / 4),
      );
      return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
    };

    const finishChatStream = (accumulated: string) => {
      if (!latency.has("model_complete")) latency.mark("model_complete");
      logTrafficResponse(
        config.verbose,
        model ?? cursorModel,
        accumulated,
        true,
      );
      const usage = usageFor(agentPrompt, accumulated);
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: displayModel,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage,
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      latency.mark("shape_done");
      logLatency(config, latency, { ok: true, model: displayModel });
    };

    const finishBufferedToolStream = (
      accumulated: string,
      accumulatedThought: string,
    ) => {
      if (!latency.has("model_complete")) latency.mark("model_complete");
      logTrafficResponse(
        config.verbose,
        model ?? cursorModel,
        accumulated,
        true,
      );
      if (
        containsToolCallCandidate(accumulated) &&
        !parseToolCallOutput(accumulated, body.tools, {
          toolChoice: body.tool_choice,
        })
      ) {
        console.warn(
          `[tool-calls] rejected model tool output for ${displayModel ?? "default"}`,
        );
      }
      const buffered = buildBufferedStreamChunks({
        id,
        created,
        model: displayModel,
        text: accumulated,
        tools: body.tools,
        usage: usageFor(agentPrompt, accumulated),
        options: { toolChoice: body.tool_choice },
      });
      const reasoningDelta = thoughtStreamDelta(
        accumulatedThought,
        config.thoughtMode,
      );
      if (reasoningDelta) {
        buffered.unshift({
          id,
          object: "chat.completion.chunk",
          created,
          model: displayModel,
          choices: [
            { index: 0, delta: reasoningDelta, finish_reason: null },
          ],
        });
      }
      ensureHeaders();
      for (const chunk of buffered) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      latency.mark("shape_done");
      logLatency(config, latency, { ok: true, model: displayModel });
    };

    if (config.useAcp && typeof promptForAgent === "string") {
      let accumulated = "";
      let accumulatedThought = "";
      try {
        latency.mark("account_select_end");
        latency.mark("spawn_start");
        const outcome = await runStreamWithAccountFailover({
          signal: abortController.signal,
          onCommit: ensureHeaders,
          onChunk: (chunk) => {
            accumulated += chunk;
            if (!toolBridgeActive) writeChatChunk(chunk);
            else markModelFirstByte(latency);
          },
          ...(!toolBridgeActive && config.thoughtMode === "reasoning"
            ? {
                onThought: (chunk: string) => {
                  const delta = thoughtStreamDelta(chunk, "reasoning");
                  if (!delta) return;
                  res.write(
                    `data: ${JSON.stringify({
                      id,
                      object: "chat.completion.chunk",
                      created,
                      model: displayModel,
                      choices: [{ index: 0, delta, finish_reason: null }],
                    })}\n\n`,
                  );
                },
              }
            : {}),
          runOnce: (configDir, onChunk, onThought) =>
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
              toolBridgeActive
                ? (t) => {
                    accumulatedThought += t;
                  }
                : onThought,
            ),
        });

        if (outcome.status === "aborted") {
          latency.mark("shape_done");
          logLatency(config, latency, {
            ok: false,
            aborted: true,
            model: displayModel,
          });
          if (headersWritten) res.end();
          return;
        }

        if (outcome.status === "all_rate_limited") {
          latency.mark("shape_done");
          logLatency(config, latency, { ok: false, model: displayModel });
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
          latency.mark("shape_done");
          logLatency(config, latency, { ok: false, model: displayModel });
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
          latency.mark("shape_done");
          logLatency(config, latency, { ok: false, model: displayModel });
          res.end();
          return;
        }

        if (toolBridgeActive) {
          finishBufferedToolStream(accumulated, accumulatedThought);
        } else {
          ensureHeaders();
          finishChatStream(accumulated);
        }
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
        if (err instanceof AdmissionCapacityError) {
          latency.mark("shape_done");
          logLatency(config, latency, { ok: false, model: displayModel });
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: AGENT_CAPACITY_MESSAGE,
                code: "agent_capacity",
                retry_after_ms: err.retryAfterMs,
              },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        console.error(
          `[${new Date().toISOString()}] Agent stream error:`,
          err,
        );
        latency.mark("shape_done");
        logLatency(config, latency, { ok: false, model: displayModel });
        if (headersWritten) res.end();
      }
      return;
    }

    let accumulated = "";
    try {
      latency.mark("account_select_end");
      latency.mark("spawn_start");
      const outcome = await runStreamWithAccountFailover({
        signal: abortController.signal,
        onCommit: ensureHeaders,
        onChunk: (text) => {
          accumulated += text;
          if (!toolBridgeActive) writeChatChunk(text);
          else markModelFirstByte(latency);
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
        latency.mark("shape_done");
        logLatency(config, latency, {
          ok: false,
          aborted: true,
          model: displayModel,
        });
        if (headersWritten) res.end();
        return;
      }

      if (outcome.status === "all_rate_limited") {
        latency.mark("shape_done");
        logLatency(config, latency, { ok: false, model: displayModel });
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
        latency.mark("shape_done");
        logLatency(config, latency, { ok: false, model: displayModel });
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
        latency.mark("shape_done");
        logLatency(config, latency, { ok: false, model: displayModel });
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

      if (toolBridgeActive) {
        finishBufferedToolStream(accumulated, "");
      } else {
        ensureHeaders();
        finishChatStream(accumulated);
      }
      logAccountStats(config.verbose, getAccountStats());
      res.end();
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] Agent stream error:`,
        err,
      );
      latency.mark("shape_done");
      logLatency(config, latency, { ok: false, model: displayModel });
      if (headersWritten) res.end();
    }
    return;
  }

  latency.mark("exec_start");
  latency.mark("account_select_start");
  const abortController = new AbortController();
  abortOnClientDisconnect(res, abortController);

  latency.mark("account_select_end");
  latency.mark("spawn_start");
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
    latency.mark("shape_done");
    logLatency(config, latency, {
      ok: false,
      aborted: true,
      model: displayModel,
    });
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
    latency.mark("shape_done");
    logLatency(config, latency, { ok: false, model: displayModel });
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
    latency.mark("shape_done");
    logLatency(config, latency, { ok: false, model: displayModel });
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

  if (!latency.has("spawn_ready")) latency.mark("spawn_ready");
  if (!latency.has("session_ready")) latency.mark("session_ready");
  if (!latency.has("model_first_byte")) latency.mark("model_first_byte");
  if (!latency.has("model_complete")) latency.mark("model_complete");
  const content = (outcome.result.stdout ?? "").trim();
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);

  const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
  const completionTokens = Math.max(1, Math.round(content.length / 4));
  const totalTokens = promptTokens + completionTokens;
  const resolved = toolBridgeActive
    ? resolveAssistantOutput(content, body.tools, {
        toolChoice: body.tool_choice,
      })
    : { kind: "text" as const, content };
  if (
    toolBridgeActive &&
    resolved.kind === "text" &&
    containsToolCallCandidate(content)
  ) {
    console.warn(
      `[tool-calls] rejected model tool output for ${displayModel ?? "default"}`,
    );
  }
  const baseMessage =
    resolved.kind === "tool_call"
      ? { role: "assistant" as const, content: null, tool_calls: [resolved.toolCall] }
      : { role: "assistant" as const, content: resolved.content };
  const message = withReasoningContent(
    baseMessage,
    outcome.result.reasoning,
    config.thoughtMode,
  );
  const finishReason =
    resolved.kind === "tool_call" ? "tool_calls" : "stop";

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
          message,
          finish_reason: finishReason,
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
