import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_KEY_FILE,
  getAccountApiKeyEnv,
  hasAccountSessionAuth,
  isApiKeyAccount,
  readAccountApiKey,
  withAccountApiKeyArgs,
  writeAccountApiKey,
  writeApiKeyAccount,
} from "./account-api-key.js";
import { TOKEN_FILE } from "./token-cache.js";

describe("account-api-key", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("writes api key files and cli-config stub", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-apikey-"));
    const configDir = path.join(tmp, "work");

    writeApiKeyAccount(configDir, "work", "  sk-test-key  ");

    expect(readAccountApiKey(configDir)).toBe("sk-test-key");
    expect(fs.readFileSync(path.join(configDir, TOKEN_FILE), "utf-8")).toBe(
      "sk-test-key",
    );
    expect(isApiKeyAccount(configDir)).toBe(true);

    const cli = JSON.parse(
      fs.readFileSync(path.join(configDir, "cli-config.json"), "utf-8"),
    ) as {
      authMethod: string;
      authInfo: { email: string; authId: string; displayName: string };
    };
    expect(cli.authMethod).toBe("api-key");
    expect(cli.authInfo.email).toBe("api-key@work");
    expect(cli.authInfo.authId).toBe("api-key:work");
    expect(cli.authInfo.displayName).toBe("API key (work)");

    const st = fs.statSync(path.join(configDir, API_KEY_FILE));
    // On platforms that support mode bits, expect owner-only.
    if (process.platform !== "win32") {
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it("rejects empty api keys", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-apikey-"));
    expect(() => writeApiKeyAccount(tmp, "x", "   ")).toThrow(/empty/i);
  });

  it("returns env overrides for spawn when key exists", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-apikey-"));
    writeApiKeyAccount(tmp, "a", "sk-abc");
    expect(getAccountApiKeyEnv(tmp)).toEqual({
      CURSOR_API_KEY: "sk-abc",
      CURSOR_AUTH_TOKEN: "sk-abc",
      AGENT_CLI_CREDENTIAL_STORE: "file",
    });
    expect(getAccountApiKeyEnv(undefined)).toBeUndefined();
    expect(getAccountApiKeyEnv(path.join(tmp, "missing"))).toBeUndefined();
  });

  it("prepends --api-key for account dirs with a stored key", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-apikey-"));
    writeApiKeyAccount(tmp, "a", "sk-abc");
    expect(withAccountApiKeyArgs(["--print", "--model", "auto"], tmp)).toEqual([
      "--api-key",
      "sk-abc",
      "--print",
      "--model",
      "auto",
    ]);
    expect(withAccountApiKeyArgs(["--print"], undefined)).toEqual(["--print"]);
    expect(
      withAccountApiKeyArgs(["--api-key", "already", "--print"], tmp),
    ).toEqual(["--api-key", "already", "--print"]);
  });

  it("stores API key on a session account without clobbering cli-config or JWT", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-dual-"));
    const configDir = path.join(tmp, "work");
    fs.mkdirSync(configDir, { recursive: true });
    const sessionConfig = {
      authMethod: "cli",
      authInfo: {
        email: "work@example.com",
        displayName: "Work",
        authId: "auth0|user-1",
      },
    };
    fs.writeFileSync(
      path.join(configDir, "cli-config.json"),
      JSON.stringify(sessionConfig, null, 2),
    );
    const jwt = "aaa.bbb.ccc";
    fs.writeFileSync(path.join(configDir, TOKEN_FILE), jwt);

    writeAccountApiKey(configDir, "crsr_attached");
    writeApiKeyAccount(configDir, "work", "crsr_via_write_api_key_account");

    expect(readAccountApiKey(configDir)).toBe("crsr_via_write_api_key_account");
    expect(hasAccountSessionAuth(configDir)).toBe(true);
    expect(isApiKeyAccount(configDir)).toBe(true);
    expect(fs.readFileSync(path.join(configDir, TOKEN_FILE), "utf-8")).toBe(jwt);
    expect(
      JSON.parse(fs.readFileSync(path.join(configDir, "cli-config.json"), "utf-8")),
    ).toEqual(sessionConfig);
  });
});
