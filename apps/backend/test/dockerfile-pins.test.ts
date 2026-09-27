/**
 * Dockerfile ↔ harness catalog pin check: `harness/catalog.ts` mirrors the CLI
 * versions the image installs, and the Dockerfile is the only other place they
 * live. One source drifted means the dashboard's Agents view advertises a
 * version the sandbox doesn't run — this test fails on that drift instead of
 * shipping a stale catalog entry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentCliCatalog } from "../src/harness/catalog.js";

const BACKEND = join(__dirname, "..");
const DOCKERFILE = readFileSync(join(BACKEND, "Dockerfile"), "utf8");
const PACKAGE_JSON = JSON.parse(readFileSync(join(BACKEND, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

/** `npm i -g pkg@ver ...` line → { package: version }. */
function npmGlobalPins(dockerfile: string): Record<string, string> {
  const match = dockerfile.match(/npm i -g\s+((?:\S+\s*)+)/);
  if (!match) {
    throw new Error("Dockerfile has no `npm i -g` install line for harness CLIs");
  }
  const pins: Record<string, string> = {};
  for (const spec of match[1]!.trim().split(/\s+/)) {
    // Scoped packages carry a second @ between name and version: @scope/name@1.2.3.
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    pins[spec.slice(0, at)] = spec.slice(at + 1);
  }
  return pins;
}

/** `ARG NAME=value` lines → { NAME: value }. */
function argPins(dockerfile: string): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const match of dockerfile.matchAll(/^ARG\s+([A-Z_]+)=(\S+)/gm)) {
    pins[match[1]!] = match[2]!;
  }
  return pins;
}

// Harness id → where the Dockerfile pins its CLI. The npm install line pins
// most of them; devin is a checksum-verified tarball pinned by ARG.
const PIN_SOURCE: Record<string, { npm?: string; arg?: string }> = {
  opencode: { npm: "opencode-ai" },
  "claude-code": { npm: "@anthropic-ai/claude-code" },
  codex: { npm: "@openai/codex" },
  grok: { npm: "@xai-official/grok" },
  devin: { arg: "DEVIN_CLI_VERSION" },
};

describe("Dockerfile pins", () => {
  const npmPins = npmGlobalPins(DOCKERFILE);
  const args = argPins(DOCKERFILE);

  it("catalog versions match the image's pinned CLI versions", () => {
    for (const cli of agentCliCatalog({})) {
      const source = PIN_SOURCE[cli.id];
      expect(source, `no Dockerfile pin source mapped for harness ${cli.id}`).toBeDefined();
      const pinned = source!.npm ? npmPins[source!.npm] : args[source!.arg!];
      expect(pinned, `no Dockerfile pin found for harness ${cli.id}`).toBeDefined();
      expect(
        cli.version,
        `catalog says ${cli.id}@${cli.version} but the Dockerfile pins ${pinned}`,
      ).toBe(pinned);
    }
  });

  it("base image tag matches the @cloudflare/sandbox npm version", () => {
    const from = DOCKERFILE.match(/^FROM docker\.io\/cloudflare\/sandbox:([0-9.]+)-opencode$/m);
    expect(from, "base image is not a versioned cloudflare/sandbox tag").not.toBeNull();
    const dep = PACKAGE_JSON.dependencies["@cloudflare/sandbox"];
    expect(dep).toBeDefined();
    // package.json may carry a semver range (^, ~) — the image pin is exact.
    expect(dep!.replace(/^[~^]/, "")).toBe(from![1]);
  });
});
