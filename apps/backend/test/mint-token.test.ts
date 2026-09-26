import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashToken, SCOPES, TOKEN_PREFIX, verifyToken } from "../src/agent-tokens.js";

const script = fileURLToPath(new URL("../../../scripts/mint-token.mjs", import.meta.url));
const mint = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("scripts/mint-token.mjs", () => {
  it("builds a KV record the Worker's verifyToken accepts", async () => {
    const out = mint("--agent", "claude-code", "--scopes", "sandbox:exec,memory:read", "--host", "https://shiba.example.dev/");
    expect(out.status).toBe(0);
    const field = (name: string) => out.stdout.match(new RegExp(`^${name}:\\s+(\\S+)`, "m"))?.[1] ?? "";
    const [token, key, value] = [field("token"), field("key"), field("value")];
    expect(key).toBe(`${TOKEN_PREFIX}${await hashToken(token)}`);
    const kv = { get: async (k: string) => (k === key ? value : null) } as unknown as KVNamespace;
    expect(await verifyToken({ AGENT_TOKENS: kv }, token)).toEqual({
      principal: "claude-code",
      scopes: ["sandbox:exec", "memory:read"],
      created: expect.any(Number),
      revoked: false,
    });
    expect(out.stdout).toContain(`npx wrangler kv key put --binding AGENT_TOKENS --config apps/backend/wrangler.jsonc ${key} '${value}' --remote`);
    expect(out.stdout).toContain(
      `claude mcp add --transport http shiba https://shiba.example.dev/mcp --header "Authorization: Bearer ${token}"`,
    );
  });

  it("--help lists exactly the Worker's scopes and unknown scopes are refused", () => {
    const help = mint("--help");
    expect(help.stdout.match(/^Valid scopes: (.+)$/m)?.[1]?.split(", ")).toEqual([...SCOPES]);
    const bad = mint("--agent", "a", "--scopes", "sandbox:root");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('unknown scope "sandbox:root"');
  });
});
