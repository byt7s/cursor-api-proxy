import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { launch as launchChrome } from "chrome-launcher";

import { writeApiKeyAccount } from "../lib/account-api-key.js";
import { loadEnvConfig, resolveAgentCommand } from "../lib/env.js";
import { ACCOUNTS_DIR } from "./constants.js";
import { readKeychainToken, writeCachedToken } from "./usage.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const LOGIN_URL_RE =
  /(https:\/\/cursor\.com\/loginDeepControl.*?redirectTarget=cli)/s;

async function openIncognito(url: string, proxies: string[]): Promise<void> {
  const chromeFlags = [
    "--incognito",
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-translate",
  ];

  if (proxies.length > 0) {
    const proxy = proxies[Math.floor(Math.random() * proxies.length)];
    chromeFlags.push(`--proxy-server=${proxy}`);
    console.log(`🔀 Using proxy: ${proxy}`);
  }

  try {
    await launchChrome({
      startingUrl: url,
      chromeFlags,
      ignoreDefaultFlags: true,
      handleSIGINT: false,
      logLevel: "silent",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`\n🌐 Could not open Chrome automatically: ${msg}`);
    console.log(
      `Please open this URL in a private/incognito window:\n${url}\n`,
    );
  }
}

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Prompt for a secret; hides typed characters when stdin is a TTY. */
export function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return promptLine(question);
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          cleanup();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          stdout.write("\n");
          reject(new Error("Login cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " " || ch === "\u001b") continue;
        value += ch;
        stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

export async function promptLoginMethod(): Promise<"cli" | "api-key"> {
  console.log("How do you want to authenticate this account?");
  console.log("  [1] Cursor CLI (browser login)");
  console.log(
    "  [2] API key (paste a key from https://cursor.com/dashboard/api)",
  );

  for (;;) {
    const choice = await promptLine("Choice [1/2]: ");
    if (choice === "1" || choice.toLowerCase() === "cli") return "cli";
    if (choice === "2" || choice.toLowerCase() === "api-key" || choice.toLowerCase() === "key") {
      return "api-key";
    }
    console.log("Please enter 1 or 2.");
  }
}

/**
 * Persist an API-key account (testable without TTY).
 */
export function saveApiKeyAccount(
  accountName: string,
  apiKey: string,
): { name: string; configDir: string } {
  const name = accountName || `account-${Date.now().toString().slice(-4)}`;
  const configDir = path.join(ACCOUNTS_DIR, name);
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  writeApiKeyAccount(configDir, name, apiKey);
  return { name, configDir };
}

async function handleLoginWithApiKey(accountName: string): Promise<void> {
  const name = accountName || `account-${Date.now().toString().slice(-4)}`;
  const configDir = path.join(ACCOUNTS_DIR, name);

  console.log(`🔑 Adding Cursor API key account: ${name}`);
  console.log(`📁 Config: ${configDir}`);
  console.log("");

  const key = await promptSecret("Paste API key (input hidden): ");
  if (!key) {
    throw new Error("API key must not be empty");
  }

  saveApiKeyAccount(name, key);
  console.log(
    `\n✅ Account '${name}' saved with API key — it will be auto-discovered when you start the proxy.`,
  );
}

async function handleLoginWithCli(
  accountName: string,
  proxies: string[] = [],
): Promise<void> {
  const envCfg = loadEnvConfig();
  const name = accountName || `account-${Date.now().toString().slice(-4)}`;
  const configDir = path.join(ACCOUNTS_DIR, name);

  const dirWasNew = !fs.existsSync(configDir);

  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  console.log(`🔑 Logging into Cursor account: ${name}`);
  console.log(`📁 Config: ${configDir}`);
  console.log("");
  console.log(
    "A Chrome incognito window will open — complete the login there.",
  );
  console.log("");

  return new Promise<void>((resolve, reject) => {
    let browserOpened = false;
    let stdoutBuffer = "";

    const cleanupDir = () => {
      if (!dirWasNew) return;
      try {
        fs.rmSync(configDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };

    const resolved = resolveAgentCommand(envCfg.agentBin, ["login"]);
    const child = spawn(resolved.command, resolved.args, {
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...resolved.env,
        CURSOR_CONFIG_DIR: configDir,
        NO_OPEN_BROWSER: "1",
      },
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });

    const onCancel = (signal: string) => {
      child.kill();
      cleanupDir();
      if (signal === "SIGINT") console.log("\n\n❌ Login cancelled.");
      process.exit(0);
    };
    const onSigint = () => onCancel("SIGINT");
    const onSigterm = () => onCancel("SIGTERM");
    const onSighup = () => onCancel("SIGHUP");

    const removeSignalHandlers = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGHUP", onSighup);
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    process.once("SIGHUP", onSighup);

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(text);
      stdoutBuffer += text;

      if (
        !browserOpened &&
        stdoutBuffer.includes("https://cursor.com/loginDeepControl")
      ) {
        const match = stdoutBuffer.match(LOGIN_URL_RE);
        if (match?.[1]) {
          const url = match[1].replace(/\s+/g, "");
          openIncognito(url, proxies).catch(() => {});
          browserOpened = true;
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(data.toString());
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      removeSignalHandlers();
      cleanupDir();
      if (err.code === "ENOENT") {
        console.error(
          `❌ Could not find '${envCfg.agentBin}'. Make sure the Cursor CLI is installed.`,
        );
      } else {
        console.error("❌ Error launching agent login:", err);
      }
      reject(err);
    });

    child.on("exit", (code: number | null) => {
      removeSignalHandlers();
      if (code === 0) {
        const token = readKeychainToken();
        if (token) writeCachedToken(configDir, token);

        console.log(
          `\n✅ Account '${name}' saved — it will be auto-discovered when you start the proxy.`,
        );
        resolve();
      } else {
        cleanupDir();
        console.error(`\n❌ Login failed (exit code ${code}).`);
        reject(new Error(`Login failed with code ${code}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function handleLogin(
  accountName: string,
  proxies: string[] = [],
): Promise<void> {
  const name = accountName || `account-${Date.now().toString().slice(-4)}`;

  console.log(`🔑 Cursor account: ${name}`);
  console.log("");

  const method = await promptLoginMethod();
  console.log("");

  if (method === "api-key") {
    await handleLoginWithApiKey(name);
    return;
  }

  await handleLoginWithCli(name, proxies);
}
