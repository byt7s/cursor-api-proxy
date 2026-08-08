import { randomUUID } from "node:crypto";
import * as http from "node:http";

import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import { getAccountStats } from "../account-pool.js";
import {
  ALL_ACCOUNTS_DISABLED_MESSAGE,
  ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
  MODEL_NOT_ALLOWED_CODE,
  MODEL_NOT_ALLOWED_MESSAGE,
  runStreamWithAccountFailover,
  runSyncWithAccountFailover,
} from "../account-failover.js";
import {
  BRIDGE_AGENT_PROMPT_SEPARATOR,
  buildBridgeContextPreamble,
} from "../bridge-context-preamble.js";
import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import { json, writeSseHeaders } from "../http.js";
import {
  AdmissionCapacityError,
  AGENT_CAPACITY_MESSAGE,
} from "../admission.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { createStreamParser } from "../cli-stream-parser.js";
import {
  IMAGES_NOT_SUPPORTED_CODE,
  IMAGES_NOT_SUPPORTED_MESSAGE,
  responsesInputContainsImages,
  stripImagesFromResponsesInput,
} from "../image-content.js";
import {
  buildPromptFromMessages,
  responsesInputToMessages,
  toolsToSystemText,
  type OpenAiResponsesRequest,
} from "../openai.js";
import {
  logAccountStats,
  logAgentError,
  logModelResolution,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../request-log.js";
import {
  isModelNotFoundMessage,
  MODEL_NOT_FOUND_CODE,
  modelNotFoundPublicMessage,
} from "../acp-model.js";
import { resolveRequestModel } from "../resolve-request-model.js";
import { resolveRequestMode } from "../resolve-mode.js";
import { sanitizeMessages } from "../sanitize.js";
import { resolveWorkspace } from "../workspace.js";
import {
  fitPromptToWinCmdline,
  warnPromptTruncated,
} from "../win-cmdline-limit.js";
import { abortOnClientDisconnect } from "../client-disconnect.js";
import type { ModelCacheRef } from "./models.js";

export type ResponsesCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
  modelCacheRef: ModelCacheRef;
};

type ResponseStatus = "in_progress" | "completed" | "failed";

function createResponseObject(opts: {
  body: OpenAiResponsesRequest;
  id: string;
  itemId: string;
  createdAt: number;
  model: string | undefined;
  status: ResponseStatus;
  text: string;
  promptTokens: number;
  completionTokens: number;
  error?: { message: string; code: string } | null;
}) {
  const output =
    opts.status === "completed"
      ? [
          {
            id: opts.itemId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: opts.text,
                annotations: [],
              },
            ],
          },
        ]
      : [];
  const totalTokens = opts.promptTokens + opts.completionTokens;

  return {
    id: opts.id,
    object: "response",
    created_at: opts.createdAt,
    status: opts.status,
    background: false,
    error: opts.error ?? null,
    incomplete_details: null,
    instructions: opts.body.instructions ?? null,
    max_output_tokens: opts.body.max_output_tokens ?? null,
    model: opts.model,
    output,
    output_text: opts.text,
    parallel_tool_calls: opts.body.parallel_tool_calls ?? true,
    previous_response_id: opts.body.previous_response_id ?? null,
    reasoning: opts.body.reasoning ?? null,
    service_tier: opts.body.service_tier ?? "default",
    store: opts.body.store ?? false,
    temperature: opts.body.temperature ?? null,
    text: opts.body.text ?? { format: { type: "text" } },
    tool_choice: opts.body.tool_choice ?? "auto",
    tools: opts.body.tools ?? [],
    top_p: opts.body.top_p ?? null,
    truncation: opts.body.truncation ?? "disabled",
    usage: {
      input_tokens: opts.promptTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: opts.completionTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: totalTokens,
    },
    user: opts.body.user ?? null,
    metadata: opts.body.metadata ?? null,
  };
}

function createOutputItem(itemId: string, status: ResponseStatus, text: string) {
  return {
    id: itemId,
    type: "message",
    status,
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        annotations: [],
      },
    ],
  };
}

function writeResponseEvent(
  res: http.ServerResponse,
  type: string,
  data: Record<string, unknown>,
): void {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

function responseContentText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p) =>
          p?.type === "text" ||
          p?.type === "input_text" ||
          p?.type === "output_text",
      )
      .map((p) => p.text ?? "")
      .join("");
  }
  return "";
}

export async function handleResponses(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ResponsesCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const { config, lastRequestedModelRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as OpenAiResponsesRequest;
  // Skip agent --list-models on the hot path (~2s); GET /v1/models still lists.
  const modelResolution = resolveRequestModel(body.model, lastRequestedModelRef, config);
  if (!modelResolution.ok) {
    json(res, modelResolution.status, modelResolution.body);
    return;
  }
  const { cursorModel, displayModel, decision } = modelResolution;
  logModelResolution(config.verbose, decision);

  let requestBody = body;
  if (responsesInputContainsImages(body.input)) {
    if (!config.ignoreImages) {
      json(res, 400, {
        error: {
          message: IMAGES_NOT_SUPPORTED_MESSAGE,
          code: IMAGES_NOT_SUPPORTED_CODE,
        },
      });
      return;
    }
    console.warn(
      "[images] stripping image parts (CURSOR_BRIDGE_IGNORE_IMAGES=true)",
    );
    res.setHeader("X-Cursor-Proxy-Images-Ignored", "true");
    requestBody = {
      ...body,
      input: stripImagesFromResponsesInput(body.input) as typeof body.input,
    };
  }

  const cleanMessages = sanitizeMessages(responsesInputToMessages(requestBody));
  const toolsText = toolsToSystemText(requestBody.tools);
  const messagesWithTools = toolsText
    ? [{ role: "system", content: toolsText }, ...cleanMessages]
    : cleanMessages;
  const prompt = buildPromptFromMessages(messagesWithTools);

  const trafficMessages: TrafficMessage[] = cleanMessages.map((m: any) => ({
    role: String(m?.role ?? "user"),
    content: responseContentText(m),
  }));
  logTrafficRequest(
    config.verbose,
    displayModel,
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
        hasTools: Array.isArray(body.tools) && body.tools.length > 0,
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

  const id = `resp_${randomUUID().replace(/-/g, "")}`;
  const itemId = `msg_${randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
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
      if (headersWritten) return;
      headersWritten = true;
      writeSseHeaders(res, truncatedHeaders);
      const initialResponse = createResponseObject({
        body,
        id,
        itemId,
        createdAt,
        model: displayModel,
        status: "in_progress",
        text: "",
        promptTokens: Math.max(1, Math.round(agentPrompt.length / 4)),
        completionTokens: 0,
      });
      writeResponseEvent(res, "response.created", { response: initialResponse });
      writeResponseEvent(res, "response.output_item.added", {
        response_id: id,
        output_index: 0,
        item: createOutputItem(itemId, "in_progress", ""),
      });
      writeResponseEvent(res, "response.content_part.added", {
        response_id: id,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    };

    const writeChunk = (chunk: string) => {
      writeResponseEvent(res, "response.output_text.delta", {
        response_id: id,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: chunk,
      });
    };

    const finishStream = (accumulated: string) => {
      logTrafficResponse(config.verbose, displayModel, accumulated, true);
      const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
      const completionTokens = Math.max(1, Math.round(accumulated.length / 4));
      const completedItem = createOutputItem(itemId, "completed", accumulated);
      writeResponseEvent(res, "response.output_text.done", {
        response_id: id,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: accumulated,
      });
      writeResponseEvent(res, "response.content_part.done", {
        response_id: id,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: completedItem.content[0],
      });
      writeResponseEvent(res, "response.output_item.done", {
        response_id: id,
        output_index: 0,
        item: completedItem,
      });
      writeResponseEvent(res, "response.completed", {
        response: createResponseObject({
          body,
          id,
          itemId,
          createdAt,
          model: displayModel,
          status: "completed",
          text: accumulated,
          promptTokens,
          completionTokens,
        }),
      });
      res.write("data: [DONE]\n\n");
    };

    if (config.useAcp && typeof promptForAgent === "string") {
      let accumulated = "";
      try {
        const outcome = await runStreamWithAccountFailover({
          requiredModel: cursorModel,
          signal: abortController.signal,
          onCommit: ensureHeaders,
          onChunk: (chunk) => {
            accumulated += chunk;
            writeChunk(chunk);
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
            writeResponseEvent(res, "error", {
              error: {
                message: ALL_ACCOUNTS_RATE_LIMITED_MESSAGE,
                code: "rate_limit_exceeded",
              },
            });
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
            writeResponseEvent(res, "error", {
              error: {
                message: ALL_ACCOUNTS_DISABLED_MESSAGE,
                code: "no_usable_accounts",
              },
            });
            res.write("data: [DONE]\n\n");
            res.end();
          }
          logAccountStats(config.verbose, getAccountStats());
          return;
        }
        if (outcome.status === "model_not_allowed") {
        if (!headersWritten) {
        json(res, 403, {
        error: {
        message: MODEL_NOT_ALLOWED_MESSAGE(outcome.model),
        code: MODEL_NOT_ALLOWED_CODE,
        model: outcome.model,
        },
        });
        } else {
        res.write(
        `data: ${JSON.stringify({
        error: {
        message: MODEL_NOT_ALLOWED_MESSAGE(outcome.model),
        code: MODEL_NOT_ALLOWED_CODE,
        model: outcome.model,
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
          writeResponseEvent(res, "error", {
            error: { message: publicMsg, code: "cursor_cli_error" },
          });
          res.write("data: [DONE]\n\n");
          logAccountStats(config.verbose, getAccountStats());
          res.end();
          return;
        }

        ensureHeaders();
        finishStream(accumulated);
        logAccountStats(config.verbose, getAccountStats());
        res.end();
      } catch (err) {
        if (!abortController.signal.aborted) {
          ensureHeaders();
          writeResponseEvent(res, "error", {
            error: {
              message:
                "The Cursor agent stream failed. See server logs for details.",
              code: "cursor_cli_error",
            },
          });
          res.write("data: [DONE]\n\n");
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
          requiredModel: cursorModel,
        signal: abortController.signal,
        onCommit: ensureHeaders,
        onChunk: (text) => {
          accumulated += text;
          writeChunk(text);
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
      if (outcome.status === "model_not_allowed") {
      if (!headersWritten) {
      json(res, 403, {
      error: {
      message: MODEL_NOT_ALLOWED_MESSAGE(outcome.model),
      code: MODEL_NOT_ALLOWED_CODE,
      model: outcome.model,
      },
      });
      } else {
      res.write(
      `data: ${JSON.stringify({
      error: {
      message: MODEL_NOT_ALLOWED_MESSAGE(outcome.model),
      code: MODEL_NOT_ALLOWED_CODE,
      model: outcome.model,
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
      finishStream(accumulated);
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
    { requiredModel: cursorModel },
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
  if (outcome.status === "model_not_allowed") {
  json(res, 403, {
  error: {
  message: MODEL_NOT_ALLOWED_MESSAGE(outcome.model),
  code: MODEL_NOT_ALLOWED_CODE,
  model: outcome.model,
  },
  });
  logAccountStats(config.verbose, getAccountStats());
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
    const modelMissing = isModelNotFoundMessage(outcome.result.stderr);
    json(res, modelMissing ? 400 : 500, {
      error: {
        message: modelMissing
          ? modelNotFoundPublicMessage(outcome.result.stderr, displayModel)
          : errMsg,
        code: modelMissing ? MODEL_NOT_FOUND_CODE : "cursor_cli_error",
        ...(modelMissing ? { model: displayModel } : {}),
      },
    });
    return;
  }

  const content = (outcome.result.stdout ?? "").trim();
  logTrafficResponse(config.verbose, displayModel, content, false);

  const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
  const completionTokens = Math.max(1, Math.round(content.length / 4));

  logAccountStats(config.verbose, getAccountStats());
  json(
    res,
    200,
    createResponseObject({
      body,
      id,
      itemId,
      createdAt,
      model: displayModel,
      status: "completed",
      text: content,
      promptTokens,
      completionTokens,
    }),
    truncatedHeaders,
  );
}
