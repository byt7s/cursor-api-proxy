import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { AnthropicMessagesRequest } from "../anthropic.js";
import { buildPromptFromAnthropicMessages } from "../anthropic.js";
import {
  buildBridgeContextPreamble,
  BRIDGE_AGENT_PROMPT_SEPARATOR,
} from "../bridge-context-preamble.js";
import { resolveClientLaunchInfo } from "../client-process.js";
import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import {
  AdmissionCapacityError,
  AGENT_CAPACITY_MESSAGE,
} from "../admission.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { createStreamParser } from "../cli-stream-parser.js";
import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import type { ModelCacheRef } from "./models.js";
import { json, writeSseHeaders } from "../http.js";
import {
  IMAGES_NOT_SUPPORTED_CODE,
  IMAGES_NOT_SUPPORTED_MESSAGE,
  messagesContainImages,
  stripImagesFromMessages,
} from "../image-content.js";
import { resolveModelWithoutCatalog } from "../model-map.js";
import { normalizeModelId, toolsToSystemText } from "../openai.js";
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
import { sanitizeMessages, sanitizeSystem } from "../sanitize.js";
import { getAccountStats } from "../account-pool.js";
import {
  ALL_ACCOUNTS_DISABLED_MESSAGE,
  ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
  runStreamWithAccountFailover,
  runSyncWithAccountFailover,
} from "../account-failover.js";
import {
  buildToolBridgeSystemText,
  resolveAnthropicAssistantOutput,
  shouldUseToolBridge,
} from "../tool-calls.js";
import {
  fitPromptToWinCmdline,
  warnPromptTruncated,
} from "../win-cmdline-limit.js";
import { abortOnClientDisconnect } from "../client-disconnect.js";

export type AnthropicMessagesCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
  modelCacheRef: ModelCacheRef;
};

export async function handleAnthropicMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AnthropicMessagesCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const { config, lastRequestedModelRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as AnthropicMessagesRequest;
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
  const displayModel =
    decision.requestedWasDefault && config.defaultModel !== "default"
      ? config.defaultModel
      : model;

  const cleanSystem = sanitizeSystem(body.system);
  let cleanMessages = sanitizeMessages(
    body.messages ?? [],
  ) as AnthropicMessagesRequest["messages"];

  if (messagesContainImages(cleanMessages)) {
    if (!config.ignoreImages) {
      json(res, 400, {
        error: {
          type: "invalid_request_error",
          message: IMAGES_NOT_SUPPORTED_MESSAGE,
          code: IMAGES_NOT_SUPPORTED_CODE,
        },
      });
      return;
    }
    console.warn(
      "[images] stripping image blocks (CURSOR_BRIDGE_IGNORE_IMAGES=true)",
    );
    cleanMessages = stripImagesFromMessages(cleanMessages);
  }

  const toolBridgeActive =
    config.toolCalls &&
    shouldUseToolBridge((body as any).tools, (body as any).tool_choice);
  const toolsText = config.toolCalls
    ? toolBridgeActive
      ? buildToolBridgeSystemText(
          (body as any).tools,
          (body as any).tool_choice,
        )
      : undefined
    : toolsToSystemText((body as any).tools);
  const systemWithTools = toolsText
    ? [cleanSystem, toolsText].filter(Boolean).join("\n\n")
    : cleanSystem;
  const prompt = buildPromptFromAnthropicMessages(
    cleanMessages,
    systemWithTools as AnthropicMessagesRequest["system"],
  );

  if (body.max_tokens == null || typeof body.max_tokens !== "number") {
    json(res, 400, {
      error: {
        type: "invalid_request_error",
        message: "max_tokens is required",
      },
    });
    return;
  }

  const trafficMessages: TrafficMessage[] = [];
  if (cleanSystem) {
    const sys =
      typeof cleanSystem === "string"
        ? cleanSystem
        : (cleanSystem as Array<{ type?: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n");
    if (sys.trim())
      trafficMessages.push({ role: "system", content: sys.trim() });
  }
  for (const m of cleanMessages) {
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type?: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
    if (text) trafficMessages.push({ role: m.role, content: text });
  }
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
    json(res, 400, {
      error: {
        type: "invalid_request_error",
        message: msg,
        code: "invalid_mode",
      },
    });
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
    json(res, 400, {
      error: { type: "invalid_request_error", message: msg },
    });
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
        type: "api_error",
        message: fit.error,
        code: "windows_cmdline_limit",
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

  const msgId = `msg_${randomUUID().replace(/-/g, "")}`;

  const truncatedHeaders = fit.truncated
    ? { "X-Cursor-Proxy-Prompt-Truncated": "true" }
    : undefined;

  const promptForAgent =
    config.promptViaStdin || config.useAcp ? agentPrompt : undefined;

  if (body.stream) {
    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);
    res.on("error", () => {
      /* client disconnected mid-stream */
    });

    let headersWritten = false;
    const writeEvent = (evt: object) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };

    const ensureHeaders = () => {
      if (headersWritten) return;
      headersWritten = true;
      writeSseHeaders(res, truncatedHeaders);
      writeEvent({
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model: displayModel ?? cursorModel,
          content: [],
        },
      });
      writeEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
    };

    const finishAnthropicStream = (accumulated: string) => {
      logTrafficResponse(
        config.verbose,
        model ?? cursorModel,
        accumulated,
        true,
      );
      if (toolBridgeActive) {
        const shaped = resolveAnthropicAssistantOutput(
          accumulated,
          (body as any).tools,
          { toolChoice: (body as any).tool_choice },
        );
        if (shaped.kind === "tool_use") {
          // Buffered tool path: replace the empty text block with tool_use.
          writeEvent({ type: "content_block_stop", index: 0 });
          writeEvent({
            type: "content_block_start",
            index: 1,
            content_block: shaped.content[0],
          });
          writeEvent({ type: "content_block_stop", index: 1 });
          writeEvent({
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 0 },
          });
          writeEvent({ type: "message_stop" });
          return;
        }
      }
      writeEvent({ type: "content_block_stop", index: 0 });
      writeEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      writeEvent({ type: "message_stop" });
    };

    if (config.useAcp && typeof promptForAgent === "string") {
      let accumulated = "";
      try {
        const outcome = await runStreamWithAccountFailover({
          signal: abortController.signal,
          onCommit: ensureHeaders,
          onChunk: (chunk) => {
            accumulated += chunk;
            if (toolBridgeActive) return;
            writeEvent({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: chunk },
            });
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
                type: "rate_limit_error",
                message: ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
              },
            });
          } else {
            writeEvent({
              type: "error",
              error: {
                type: "rate_limit_error",
                message: ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
              },
            });
            res.end();
          }
          logAccountStats(config.verbose, getAccountStats());
          return;
        }
        if (outcome.status === "all_disabled") {
          if (!headersWritten) {
            json(res, 403, {
              error: {
                type: "invalid_request_error",
                message: ALL_ACCOUNTS_DISABLED_MESSAGE,
              },
            });
          } else {
            writeEvent({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: ALL_ACCOUNTS_DISABLED_MESSAGE,
              },
            });
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
          writeEvent({
            type: "error",
            error: { type: "api_error", message: publicMsg },
          });
          logAccountStats(config.verbose, getAccountStats());
          res.end();
          return;
        }

        ensureHeaders();
        finishAnthropicStream(accumulated);
        logAccountStats(config.verbose, getAccountStats());
        res.end();
      } catch (err) {
        if (!abortController.signal.aborted) {
          ensureHeaders();
          writeEvent({
            type: "error",
            error: {
              type: "api_error",
              message:
                "The Cursor agent stream failed. See server logs for details.",
            },
          });
        }
        if (err instanceof AdmissionCapacityError) {
          const retryAfterSec = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
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
          if (toolBridgeActive) return;
          writeEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          });
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
              type: "rate_limit_error",
              message: ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
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
              type: "invalid_request_error",
              message: ALL_ACCOUNTS_DISABLED_MESSAGE,
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
              type: "api_error",
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
      finishAnthropicStream(accumulated);
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
        type: "rate_limit_error",
        message: ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
      },
    });
    return;
  }
  if (outcome.status === "all_disabled") {
    logAccountStats(config.verbose, getAccountStats());
    json(res, 403, {
      error: {
        type: "invalid_request_error",
        message: ALL_ACCOUNTS_DISABLED_MESSAGE,
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
      error: { type: "api_error", message: errMsg, code: "cursor_cli_error" },
    });
    return;
  }

  const content = (outcome.result.stdout ?? "").trim();
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);
  logAccountStats(config.verbose, getAccountStats());
  const inTok = Math.max(1, Math.round(agentPrompt.length / 4));
  const outTok = Math.max(1, Math.round(content.length / 4));
  const shaped = toolBridgeActive
    ? resolveAnthropicAssistantOutput(content, (body as any).tools, {
        toolChoice: (body as any).tool_choice,
      })
    : {
        kind: "text" as const,
        content,
        stop_reason: "end_turn" as const,
      };
  json(
    res,
    200,
    {
      id: msgId,
      type: "message",
      role: "assistant",
      content:
        shaped.kind === "tool_use"
          ? shaped.content
          : [{ type: "text", text: shaped.content }],
      model: displayModel ?? cursorModel,
      stop_reason: shaped.stop_reason,
      usage: {
        input_tokens: inTok,
        output_tokens: outTok,
      },
    },
    truncatedHeaders,
  );
}
