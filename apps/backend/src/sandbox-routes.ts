import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";

const SAFE_SANDBOX_ID_RE = /^[a-zA-Z0-9_.-]{1,128}$/;

export function isValidSandboxId(id: string): boolean {
  return SAFE_SANDBOX_ID_RE.test(id);
}

export async function handleSandboxRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/sandboxes\/([^/]+)\/(info|files|file|exec|diff|processes)$/);
  if (!match) {
    return null;
  }

  const rawSandboxId = match[1];
  const action = match[2];
  if (rawSandboxId === undefined || action === undefined) {
    return null;
  }

  let sandboxId: string;
  try {
    sandboxId = decodeURIComponent(rawSandboxId);
  } catch {
    return Response.json({ error: "Invalid sandbox ID encoding." }, { status: 400 });
  }

  if (!isValidSandboxId(sandboxId)) {
    return Response.json({ error: "Invalid sandbox ID format." }, { status: 400 });
  }

  const sandbox = getSandbox(env.Sandbox, sandboxId);

  try {
    if (action === "info" && request.method === "GET") {
      let placementId: string | null | undefined = null;
      let processes: unknown[] = [];
      let reachable = true;
      try {
        placementId = await sandbox.getContainerPlacementId();
      } catch {
        // Not reachable or offline
        reachable = false;
      }
      if (reachable) {
        try {
          processes = await sandbox.listProcesses();
        } catch {
          // ignore process list error
        }
      }
      return Response.json({
        sandboxId,
        available: reachable,
        placementId: placementId ?? null,
        processes: processes ?? [],
        defaultPort: 3000,
        allowedHosts: [
          "generativelanguage.googleapis.com",
          "api.anthropic.com",
          "api.openai.com",
          "github.com",
          "codeload.github.com",
        ],
      });
    }

    if (action === "files" && request.method === "GET") {
      const targetPath = url.searchParams.get("path") || "/workspace";
      try {
        const result = await sandbox.listFiles(targetPath);
        const files = (result as { files?: unknown }).files ?? result;
        return Response.json({
          sandboxId,
          path: targetPath,
          files,
        });
      } catch (error) {
        return Response.json({
          sandboxId,
          path: targetPath,
          error: redactSecrets(error instanceof Error ? error.message : String(error)),
          files: [],
        }, { status: 404 });
      }
    }

    if (action === "file" && request.method === "GET") {
      const targetPath = url.searchParams.get("path");
      if (!targetPath) {
        return Response.json({ error: "Path parameter is required." }, { status: 400 });
      }
      try {
        const result = await sandbox.readFile(targetPath, { encoding: "utf-8" });
        const content = (result as { content?: unknown }).content ?? result;
        return Response.json({
          sandboxId,
          path: targetPath,
          content: typeof content === "string" ? content : String(content),
        });
      } catch (error) {
        return Response.json({
          sandboxId,
          path: targetPath,
          error: redactSecrets(error instanceof Error ? error.message : String(error)),
        }, { status: 404 });
      }
    }

    if (action === "exec" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON body." }, { status: 400 });
      }
      if (typeof body !== "object" || body === null) {
        return Response.json({ error: "Request body must be an object." }, { status: 400 });
      }
      const { command, cwd } = body as { command?: unknown; cwd?: unknown };
      if (typeof command !== "string" || !command.trim()) {
        return Response.json({ error: "Command string is required." }, { status: 400 });
      }
      const safeCwd = typeof cwd === "string" && cwd.trim() ? cwd.trim() : "/workspace";
      try {
        const result = await sandbox.exec(command, {
          cwd: safeCwd,
          timeout: 30000,
        });
        return Response.json({
          sandboxId,
          command,
          cwd: safeCwd,
          exitCode: result.exitCode,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          success: result.exitCode === 0,
        });
      } catch (error) {
        return Response.json({
          sandboxId,
          command,
          cwd: safeCwd,
          error: redactSecrets(error instanceof Error ? error.message : String(error)),
          exitCode: -1,
          stdout: "",
          stderr: String(error),
          success: false,
        }, { status: 500 });
      }
    }

    if (action === "diff" && request.method === "GET") {
      try {
        const result = await sandbox.exec("git diff HEAD", {
          cwd: "/workspace",
          timeout: 15000,
        });
        return Response.json({
          sandboxId,
          diff: result.stdout ?? "",
        });
      } catch (error) {
        return Response.json({
          sandboxId,
          error: redactSecrets(error instanceof Error ? error.message : String(error)),
          diff: "",
        }, { status: 500 });
      }
    }

    if (action === "processes" && request.method === "GET") {
      try {
        const processes = await sandbox.listProcesses();
        return Response.json({
          sandboxId,
          processes: processes ?? [],
        });
      } catch (error) {
        return Response.json({
          sandboxId,
          error: redactSecrets(error instanceof Error ? error.message : String(error)),
          processes: [],
        }, { status: 500 });
      }
    }

    return Response.json({ error: "Method not allowed." }, { status: 405 });
  } catch (error) {
    return Response.json({
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    }, { status: 500 });
  }
}

