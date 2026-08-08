/**
 * Minimal fake ACP server for integration tests.
 * Reads JSON-RPC from stdin, responds to initialize, authenticate, session/new, session/prompt.
 * Stays alive for multiple prompts (warm-pool tests).
 *
 * Env:
 * - FAKE_ACP_SCENARIO: unset | empty_models | dup_names | fail_set_config | with_thought
 * - FAKE_ACP_DELAY_MS: delay before answering session/prompt (holds the worker busy)
 * - FAKE_ACP_LABEL: optional label echoed in the agent message for identity checks
 * - FAKE_ACP_EXIT_AFTER_PROMPT: when "1", exit after completing one session/prompt
 *
 * Emits to stderr for assertions: __FAKE_ACP_SET_CONFIG__:<json>\n
 */
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_ACP_SCENARIO || "";
const delayMs = Number(process.env.FAKE_ACP_DELAY_MS || "0");
const label = process.env.FAKE_ACP_LABEL || "fake";
const exitAfterPrompt = process.env.FAKE_ACP_EXIT_AFTER_PROMPT === "1";
let sessionCounter = 0;

function sessionNewResult() {
  sessionCounter += 1;
  const sessionId = `sess-${sessionCounter}`;
  if (scenario === "empty_models") {
    return { sessionId, models: { availableModels: [] } };
  }
  if (scenario === "dup_names") {
    return {
      sessionId,
      models: {
        availableModels: [
          { modelId: "first-id[]", name: "gpt-4" },
          { modelId: "second-id[]", name: "gpt-4" },
        ],
      },
    };
  }
  return {
    sessionId,
    models: {
      availableModels: [{ modelId: "gpt-4[fast=false]", name: "gpt-4" }],
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  void (async () => {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && msg.method) {
        if (msg.method === "session/set_config_option") {
          process.stderr.write(
            `__FAKE_ACP_SET_CONFIG__:${JSON.stringify(msg.params)}\n`,
          );
        }

        if (
          msg.method === "session/set_config_option" &&
          scenario === "fail_set_config"
        ) {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: "Internal error" },
            }) + "\n",
          );
          return;
        }

        let result = {};
        if (msg.method === "initialize") result = { protocolVersion: 1 };
        else if (msg.method === "authenticate") result = {};
        else if (msg.method === "session/new") result = sessionNewResult();
        else if (msg.method === "session/set_config_option") result = {};
        else if (msg.method === "session/prompt") {
          if (delayMs > 0) await sleep(delayMs);
          result = {};
          if (scenario === "with_thought") {
            process.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: { text: "SECRET_THOUGHT" },
                  },
                },
              }) + "\n",
            );
          }
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { text: `Hello from fake ACP (${label})` },
                },
              },
            }) + "\n",
          );
        }
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
        );
        if (exitAfterPrompt && msg.method === "session/prompt") {
          process.exit(0);
        }
      }
    } catch {
      /* ignore */
    }
  })();
});
