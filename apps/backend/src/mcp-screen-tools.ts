// Computer-use tools for external agents (PLAN-V2-NEXT): drive a running
// run's sandbox screen — click, type, scroll, key, screenshot. Each call
// forwards one typed action to the orchestrator's /api/runs/<id>/screen
// route; the DO is the serialization point (live-run check, exec
// allowlist, signal receipts). Deliberately no batch/multi-action tool.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getAgentByName } from "agents/routing";
import {
  AGENT_PRINCIPAL_HEADER,
  screenClickInputSchema,
  screenKeyInputSchema,
  screenScrollInputSchema,
  screenShotInputSchema,
  screenTypeInputSchema,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { signInternalRequest } from "./edge-identity.js";

import type { ToolRegistry } from "./mcp-gateway.js";

const ORCHESTRATOR_NAME = "default";

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

async function orchestratorScreen(
  env: Env,
  runId: string,
  action: Record<string, unknown>,
  principal?: string,
): Promise<Record<string, unknown>> {
  const stub = await getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME);
  const request = new Request(`https://internal/api/runs/${encodeURIComponent(runId)}/screen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (principal) request.headers.set(AGENT_PRINCIPAL_HEADER, principal);
  // Edge identity: sign the vouched principal so the DO can verify the
  // Worker minted it (no-op until INTERNAL_SIGNING_KEY is configured).
  await signInternalRequest(request, env);
  const res = await stub.fetch(request);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `orchestrator returned ${res.status}`);
  }
  return body;
}

const SCREEN_TOOL_NOTE =
  "Acts on a run that is currently `running` — there is no screen until the sandbox is up.";

export function registerScreenTools(registry: ToolRegistry, env: Env): void {
  registry.registerTool(
    "screen_click",
    "sandbox:exec",
    async (args, ctx) =>
      jsonResult(
        await orchestratorScreen(
          env,
          String(args.runId),
          {
            type: "click",
            x: args.x,
            y: args.y,
            ...(args.button !== undefined ? { button: args.button } : {}),
          },
          ctx.principal.principal,
        ),
      ),
    {
      description: `Click at a pixel coordinate on the run's sandbox screen. ${SCREEN_TOOL_NOTE}`,
      inputSchema: screenClickInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  );

  registry.registerTool(
    "screen_type",
    "sandbox:exec",
    async (args, ctx) =>
      jsonResult(
        await orchestratorScreen(
          env,
          String(args.runId),
          { type: "type", text: args.text },
          ctx.principal.principal,
        ),
      ),
    {
      description: `Type literal text at the focused window on the run's screen. ${SCREEN_TOOL_NOTE}`,
      inputSchema: screenTypeInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  );

  registry.registerTool(
    "screen_scroll",
    "sandbox:exec",
    async (args, ctx) =>
      jsonResult(
        await orchestratorScreen(
          env,
          String(args.runId),
          { type: "scroll", dx: args.dx, dy: args.dy },
          ctx.principal.principal,
        ),
      ),
    {
      description: `Scroll the focused window on the run's screen (dx/dy pixels, negative reverses). ${SCREEN_TOOL_NOTE}`,
      inputSchema: screenScrollInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  );

  registry.registerTool(
    "screen_key",
    "sandbox:exec",
    async (args, ctx) =>
      jsonResult(
        await orchestratorScreen(
          env,
          String(args.runId),
          { type: "key", keys: args.keys },
          ctx.principal.principal,
        ),
      ),
    {
      description: `Send key names (xdotool syntax, e.g. "ctrl+s", "Return") to the run's screen. ${SCREEN_TOOL_NOTE}`,
      inputSchema: screenKeyInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  );

  registry.registerTool(
    "screen_shot",
    "sandbox:exec",
    async (args, ctx) => {
      const body = await orchestratorScreen(
        env,
        String(args.runId),
        { type: "shot" },
        ctx.principal.principal,
      );
      const data = typeof body.screenshotBase64 === "string" ? body.screenshotBase64 : "";
      if (data === "") {
        return jsonResult({ ok: false, error: "No screenshot returned." });
      }
      return {
        content: [{ type: "image", data, mimeType: "image/png" }],
        structuredContent: { ok: true, bytes: Math.floor((data.length * 3) / 4) },
      };
    },
    {
      description: `Capture the run's screen as a PNG (image content block). ${SCREEN_TOOL_NOTE}`,
      inputSchema: screenShotInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  );
}
