import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { copyOperatorAuth } = createRequire(import.meta.url)(
  "../../../scripts/link-operator-auth.mjs",
) as {
  copyOperatorAuth: (homeDir: string, userHome: string | undefined) => Promise<string[]>;
};

describe("copyOperatorAuth", () => {
  it("copies auth files read-only and leaves an envelope-written file alone", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "shiba-user-"));
    const runHome = mkdtempSync(join(tmpdir(), "shiba-run-"));
    mkdirSync(join(userHome, ".claude"));
    mkdirSync(join(userHome, ".codex"));
    writeFileSync(join(userHome, ".codex", "auth.json"), '{"token":"original"}\n');
    writeFileSync(join(userHome, ".claude", ".credentials.json"), '{"claude":"original"}\n');
    mkdirSync(join(runHome, ".claude"));
    writeFileSync(join(runHome, ".claude", ".credentials.json"), "envelope\n");

    const copied = await copyOperatorAuth(runHome, userHome);
    expect(copied).toEqual([".codex/auth.json"]);
    const copy = join(runHome, ".codex", "auth.json");
    expect(lstatSync(copy).isSymbolicLink()).toBe(false);
    expect(lstatSync(copy).mode & 0o777).toBe(0o444);
    expect(readFileSync(copy, "utf8")).toBe('{"token":"original"}\n');
    expect(readFileSync(join(runHome, ".claude", ".credentials.json"), "utf8")).toBe("envelope\n");
  });

  it("does not let a run command modify the real auth.json", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "shiba-user-"));
    const runHome = mkdtempSync(join(tmpdir(), "shiba-run-"));
    const real = join(userHome, ".codex", "auth.json");
    mkdirSync(join(userHome, ".codex"));
    writeFileSync(real, '{"token":"original"}\n');

    await copyOperatorAuth(runHome, userHome);
    const copy = join(runHome, ".codex", "auth.json");
    expect(readFileSync(copy, "utf8")).toBe('{"token":"original"}\n');
    expect(lstatSync(copy).isSymbolicLink()).toBe(false);
    const attempt = spawnSync(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
         const target = process.env.HOME + "/.codex/auth.json";
         try { fs.writeFileSync(target, "hacked\\n"); } catch {}
         try { fs.chmodSync(target, 0o644); fs.writeFileSync(target, "replaced\\n"); } catch {}`,
      ],
      {
        env: { HOME: runHome, PATH: process.env.PATH ?? "" },
      },
    );
    expect(attempt.status).toBe(0);
    expect(readFileSync(real, "utf8")).toBe('{"token":"original"}\n');
    expect(lstatSync(copy).isSymbolicLink()).toBe(false);
  });

  it("does not copy when the run home is the operator home", async () => {
    const home = mkdtempSync(join(tmpdir(), "shiba-same-"));
    expect(await copyOperatorAuth(home, home)).toEqual([]);
  });
});
