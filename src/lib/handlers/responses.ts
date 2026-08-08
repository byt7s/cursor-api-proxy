import { randomUUID } from "node:crypto";
import * as http from "node:http";

import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import {
  getAccountStats,
  getNextAccountConfigDir,
  reportRateLimit,
  reportRequestEnd,
  reportRequestError,
  reportRequestStart,
  reportRequestSuccess,
} from "../account-pool.js";
import {
  BRIDGE_AGENT_PROMPT_SEPARATOR,
  buildBridgeContextPreamble,
} from "../bridge-context-preamble.js";
import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import { json, writeSseHeaders } from "../http.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { createStreamParser } from "../cli-stream-parser.js";
import { resolveModelForExecution } from "../model-map.js";
import {
  buildPromptFromMessages,
  normalizeModelId,
  responsesInputToMessages,
  toolsToSystemText,
  type OpenAiResponsesRequest,
} from "../openai.js";
import {
  logAccountAssigned,
  logAccountStats,
  logAgentError,
  logModelResolution,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../request-log.js";
import { rememberResolvedModel, resolveModel } from "../resolve-model.js";
import { resolveRequestMode } from "../resolve-mode.js";
import { sanitizeMessages } from "../sanitize.js";
import { resolveWorkspace } from "../workspace.js";
import {
  fitPromptToWinCmdline,
  warnPromptTruncated,
} from "../win-cmdline-limit.js";
import { abortOnClientDisconnect } from "../client-disconnect.js";
import { getCachedCursorModels, type ModelCacheRef } from "./models.js";

function isRateLimited(stderr: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(stderr);
}

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
  const { config, lastRequestedModelRef, modelCacheRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as OpenAiResponsesRequest;
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
  const displayModel =
    decision.requestedWasDefault && config.defaultModel !== "default"
      ? config.defaultModel
      : model;

  const cleanMessages = sanitizeMessages(responsesInputToMessages(body));
  const toolsText = toolsToSystemText(body.tools);
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
    const configDir = getNextAccountConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const streamStart = Date.now();

    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);

    writeSseHeaders(res, truncatedHeaders);
    res.on("error", () => {
      /* client disconnected mid-stream */
    });

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

    const writeChunk = (chunk: string, accumulated: string) => {
      writeResponseEvent(res, "response.output_text.delta", {
        response_id: id,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: chunk,
      });
      return accumulated + chunk;
    };

    const finishStream = (accumulated: string) => {
      logTrafficResponse(config.verbose, model ?? cursorModel, accumulated, true);
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
      runAgentStream(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        (chunk) => {
          accumulated = writeChunk(chunk, accumulated);
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
            writeResponseEvent(res, "error", {
              error: { message: publicMsg, code: "cursor_cli_error" },
            });
            res.write("data: [DONE]\n\n");
            logAccountStats(config.verbose, getAccountStats());
            res.end();
            return;
          } else {
            reportRequestSuccess(configDir, latencyMs);
          }
          logAccountStats(config.verbose, getAccountStats());
          finishStream(accumulated);
          res.end();
        })
        .catch((err) => {
          reportRequestEnd(configDir);
          if (!abortController.signal.aborted) {
            reportRequestError(configDir, Date.now() - streamStart);
            writeResponseEvent(res, "error", {
              error: {
                message:
                  "The Cursor agent stream failed. See server logs for details.",
                code: "cursor_cli_error",
              },
            });
            res.write("data: [DONE]\n\n");
          }
          console.error(
            `[${new Date().toISOString()}] Agent stream error:`,
            err,
          );
          res.end();
        });
      return;
    }

    let accumulated = "";
    const parseLine = createStreamParser(
      (text) => {
        accumulated = writeChunk(text, accumulated);
      },
      () => {
        finishStream(accumulated);
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
        } else {
          reportRequestSuccess(configDir, latencyMs);
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
        res.end();
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
