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
  buildBufferedStreamChunks,
  buildToolBridgeSystemText,
  containsToolCallCandidate,
  parseToolCallOutput,
  resolveAssistantOutput,
  shouldUseToolBridge,
} from "../tool-calls.js";
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

function isRateLimited(stderr: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(stderr);
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

  const usageFor = (promptText: string, completionText: string) => {
    const promptTokens = Math.max(1, Math.round(promptText.length / 4));
    const completionTokens = Math.max(1, Math.round(completionText.length / 4));
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  };

  const writeBufferedEvents = (chunks: object[]) => {
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
  };

  if (body.stream) {
    const configDir = getNextAccountConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const streamStart = Date.now();

    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);

    // Tool-bridge turns buffer until complete; otherwise stream headers early.
    if (!toolBridgeActive) {
      writeSseHeaders(res, truncatedHeaders);
    }
    res.on("error", () => {
      /* client disconnected mid-stream */
    });

    const finishLiveStream = (accumulated: string) => {
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
    };

    const finishBufferedToolStream = (accumulated: string) => {
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
      writeSseHeaders(res, truncatedHeaders);
      writeBufferedEvents(
        buildBufferedStreamChunks({
          id,
          created,
          model: displayModel,
          text: accumulated,
          tools: body.tools,
          usage: usageFor(agentPrompt, accumulated),
          options: { toolChoice: body.tool_choice },
        }),
      );
    };

    if (config.useAcp && typeof promptForAgent === "string") {
      let accumulated = "";
      runAgentStream(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        (chunk) => {
          accumulated += chunk;
          if (toolBridgeActive) return;
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
            if (toolBridgeActive && !res.headersSent) {
              json(res, 500, {
                error: { message: publicMsg, code: "cursor_cli_error" },
              });
            } else {
              if (!res.headersSent) writeSseHeaders(res, truncatedHeaders);
              res.write(
                `data: ${JSON.stringify({
                  error: { message: publicMsg, code: "cursor_cli_error" },
                })}\n\n`,
              );
              res.write("data: [DONE]\n\n");
              res.end();
            }
            logAccountStats(config.verbose, getAccountStats());
            return;
          } else {
            reportRequestSuccess(configDir, latencyMs);
          }
          logAccountStats(config.verbose, getAccountStats());
          if (toolBridgeActive) {
            finishBufferedToolStream(accumulated);
          } else {
            finishLiveStream(accumulated);
          }
          res.end();
        })
        .catch((err) => {
          reportRequestEnd(configDir);
          if (!abortController.signal.aborted) {
            reportRequestError(configDir, Date.now() - streamStart);
            if (toolBridgeActive && !res.headersSent) {
              json(res, 500, {
                error: {
                  message:
                    "The Cursor agent stream failed. See server logs for details.",
                  code: "cursor_cli_error",
                },
              });
            } else {
              if (!res.headersSent) writeSseHeaders(res, truncatedHeaders);
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
          }
          console.error(
            `[${new Date().toISOString()}] Agent stream error:`,
            err,
          );
          if (!res.writableEnded) res.end();
        });
      return;
    }

    let accumulated = "";
    const parseLine = createStreamParser(
      (text) => {
        accumulated += text;
        if (toolBridgeActive) return;
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
        if (toolBridgeActive) {
          finishBufferedToolStream(accumulated);
          return;
        }
        finishLiveStream(accumulated);
      },
    );

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
          if (toolBridgeActive && !res.headersSent) {
            json(res, 500, {
              error: {
                message:
                  "The Cursor agent process failed. See server logs for details.",
                code: "cursor_cli_error",
              },
            });
            logAccountStats(config.verbose, getAccountStats());
            return;
          }
        } else {
          reportRequestSuccess(configDir, latencyMs);
          // CLI stream parser finish callback may not fire if the process
          // ends without a terminal event — flush buffered tool turns here.
          if (toolBridgeActive && !res.headersSent) {
            finishBufferedToolStream(accumulated);
          }
        }
        logAccountStats(config.verbose, getAccountStats());
        if (!res.writableEnded) res.end();
      })
      .catch((err) => {
        reportRequestEnd(configDir);
        if (!abortController.signal.aborted) {
          reportRequestError(configDir, Date.now() - streamStart);
          if (toolBridgeActive && !res.headersSent) {
            json(res, 500, {
              error: {
                message:
                  "The Cursor agent stream failed. See server logs for details.",
                code: "cursor_cli_error",
              },
            });
          }
        }
        console.error(
          `[${new Date().toISOString()}] Agent stream error:`,
          err,
        );
        if (!res.writableEnded) res.end();
      });
    return;
  }

  const configDir = getNextAccountConfigDir();
  logAccountAssigned(configDir);
  reportRequestStart(configDir);
  const syncStart = Date.now();

  const abortController = new AbortController();
  abortOnClientDisconnect(res, abortController);

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
    json(res, 500, {
      error: { message: errMsg, code: "cursor_cli_error" },
    });
    return;
  }

  reportRequestSuccess(configDir, syncLatency);
  const content = out.stdout.trim();
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);

  const usage = usageFor(agentPrompt, content);
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
  const message =
    resolved.kind === "tool_call"
      ? { role: "assistant", content: null, tool_calls: [resolved.toolCall] }
      : { role: "assistant", content: resolved.content };
  const finishReason =
    resolved.kind === "tool_call" ? "tool_calls" : "stop";

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
          message,
          finish_reason: finishReason,
        },
      ],
      usage,
    },
    truncatedHeaders,
  );
}
