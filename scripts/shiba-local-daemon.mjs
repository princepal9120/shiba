#!/usr/bin/env node
/**
 * shiba-local-daemon — the T51 "local" runtime's operator-side half.
 *
 * This process runs on the operator's machine (macOS/Linux, Node >= 20) and
 * is the ONLY side holding agent credentials: `claude auth login`,
 * `codex login`, provider API keys — whatever the operator's shell already
 * carries. Nothing credential-shaped ever transits the Worker; the Worker
 * posts a fully-computed run envelope and this daemon executes it.
 *
 *   SHIBA_WORKER_URL=https://shiba.example.com \
 *   LOCAL_ADAPTER_TOKEN=<the deployment's daemon bearer> \
 *   node scripts/shiba-local-daemon.mjs [--once] [--poll <ms>]
 *
 * Or pair once with a dashboard-minted token (saves ~/.shiba-local/config.json):
 *   node scripts/shiba-local-daemon.mjs --connect <workerUrl> --pair <token>
 *
 * Loop: POST /api/local/claim → execute → POST /api/local/result.
 * Claims hold the machine's slot: while a run is executing here the daemon
 * does not claim another — one daemon, one run, one process lease.
 *
 * Layout under SHIBA_LOCAL_RUN_ROOT (default ~/.shiba-local):
 *   runs/<sandboxId>/work   the cloned repo (the run's working tree)
 *   runs/<sandboxId>/home   the run's HOME (config/credentials land here)
 *   leases/run/<id>.lease   this daemon's pid, held for the run's lifetime
 * A starting daemon reaps leases whose pid is dead and deletes the dead
 * workspace — a crash never strands a half-run directory.
 *
 * The constants and wire shapes mirror packages/shared/src/local-runtime.ts
 * — this file is dependency-free on purpose so an operator can run it with
 * nothing but Node and git installed.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { copyOperatorAuth } from "./link-operator-auth.mjs";

const LOCAL_RUN_ROOT_TOKEN = "${SHIBA_LOCAL_RUN_ROOT}";
const MAX_STDERR_TAIL_CHARS = 8_000;
const MAX_STDOUT_TAIL_CHARS = 30_000;
const MAX_CAPTURED_FILES = 50;
const MAX_FILE_CHARS = 100_000;
const MAX_TOTAL_FILE_CHARS = 500_000;
const RECEIPT_COMMAND_CAP = 256;
const DEFAULT_POLL_MS = 3_000;
const DAEMON_VERSION = "0.1.0";
const HEARTBEAT_MS = 30_000;
const PROBED_HARNESSES = ["claude", "codex", "opencode", "agy"];
// EX_CONFIG: a revoked token needs operator action, not a restart loop.
const EXIT_REVOKED = 78;
// EX_TEMPFAIL: a second daemon over the same run root exits fast.
const EXIT_LOCKED = 75;

/** Status hook for a host process (worker_thread); a no-op under plain node. */
const report = (msg) => process.parentPort?.postMessage({ type: "status", ...msg });

function fail(message, code = 1) {
  console.error(`shiba-local: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { once: false, pollMs: DEFAULT_POLL_MS, connect: "", pair: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--once") args.once = true;
    else if (argv[i] === "--connect" && argv[i + 1]) args.connect = argv[++i];
    else if (argv[i] === "--pair" && argv[i + 1]) args.pair = argv[++i];
    else if (argv[i] === "--poll" && argv[i + 1]) {
      args.pollMs = Math.max(500, Number(argv[++i]) || DEFAULT_POLL_MS);
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        "Usage: shiba-local-daemon [--once] [--poll <ms>] [--connect <workerUrl> --pair <token>]\n  Env: SHIBA_WORKER_URL, LOCAL_ADAPTER_TOKEN, SHIBA_LOCAL_RUN_ROOT",
      );
      process.exit(0);
    } else {
      fail(`Unknown argument ${argv[i]}`);
    }
  }
  if (Boolean(args.connect) !== Boolean(args.pair))
    fail("--connect and --pair must be given together.");
  return args;
}

const runRoot = process.env.SHIBA_LOCAL_RUN_ROOT ?? path.join(os.homedir(), ".shiba-local");
const operator = process.env.SHIBA_LOCAL_OPERATOR ?? `${os.userInfo().username}@${os.hostname()}`;
const configPath = path.join(runRoot, "config.json");
const hostname = os.hostname();
const platform = `${process.platform}-${process.arch}`;
let workerUrl = "";
let AUTH = {};
let machineId = "";
let harnesses = [];
let activeRunId;
let activeHarnessChild;
let heldClaim;

async function post(sub, body) {
  const res = await fetch(`${workerUrl}/api/local/${sub}`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok)
    throw Object.assign(new Error(`${sub}: HTTP ${res.status} ${text.slice(0, 300)}`), {
      status: res.status,
    });
  return text === "" ? {} : JSON.parse(text);
}

// ── Signal receipts — same shape the sandbox adapter emits ──────────────
const signals = [];
function milestone(kind, detail) {
  signals.push(detail !== undefined ? { kind, at: Date.now(), detail } : { kind, at: Date.now() });
}
function receipt(command, extra) {
  return JSON.stringify({ command: command.slice(0, RECEIPT_COMMAND_CAP), ...extra });
}

/** Identical quoting to src/security.ts shellJoin — verify greps this form. */
function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}
function shellJoin(argv) {
  return argv.map(shellQuote).join(" ");
}

function boundTail(text, max) {
  return text.length <= max ? text : `…[truncated ${text.length - max} chars]\n${text.slice(-max)}`;
}

// ── Leases ──────────────────────────────────────────────────────────────
const leasePath = (id) => path.join(runRoot, "leases", "run", `${id}.lease`);

// ── Single-instance lock ────────────────────────────────────────────────
const lockPath = path.join(runRoot, "daemon.lock");
// A pid alone can be recycled after a reboot; pairing it with boot time can't.
const BOOT_SKEW_MS = 60_000;
const bootAt = () => Math.round(Date.now() - os.uptime() * 1000);

/** A lock is live only when its JSON parses, its pid answers, and it was written this boot. */
async function lockIsLive(raw) {
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof lock?.pid !== "number" || !(await holderAlive(lock.pid))) return false;
  return typeof lock.bootAt !== "number" || Math.abs(lock.bootAt - bootAt()) <= BOOT_SKEW_MS;
}

/** Exclusive-create the lock; a live holder wins, a stale one is taken over once. */
async function acquireLock() {
  await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, at: Date.now(), bootAt: bootAt() }),
      );
      await handle.close();
      // process.exit skips async cleanup — release must be synchronous.
      process.on("exit", () => {
        // revoked()/fail() exit without gracefulStop; don't orphan a mid-run harness.
        activeHarnessChild?.kill("SIGTERM");
        try {
          unlinkSync(lockPath);
        } catch {}
      });
      return;
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
    }
    const raw = await fs.readFile(lockPath, "utf8").catch(() => null);
    if (raw === null) continue;
    if (await lockIsLive(raw)) {
      fail(`another shiba-local daemon is running (pid ${JSON.parse(raw).pid})`, EXIT_LOCKED);
    }
    // rename is atomic: of several racers over one stale lock, exactly one moves it.
    const claimed = `${lockPath}.${process.pid}.stale`;
    try {
      await fs.rename(lockPath, claimed);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    // A racer may have already replaced the stale lock with its live one; hand it back.
    if ((await fs.readFile(claimed, "utf8").catch(() => raw)) !== raw) {
      await fs.link(claimed, lockPath).catch(() => {});
    }
    await fs.rm(claimed, { force: true });
  }
  fail("another shiba-local daemon is running (stale lock)", EXIT_LOCKED);
}

async function holderAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function writeLease(id) {
  const file = leasePath(id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return file;
}

async function releaseLease(id) {
  await fs.rm(leasePath(id), { force: true });
}

/** Reap dead holders' leases + workspaces at startup — crash recovery. */
async function reapDeadWorkspaces() {
  const dir = path.join(runRoot, "leases", "run");
  const entries = await fs.readdir(dir).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".lease")) continue;
    const file = path.join(dir, entry);
    let pid = null;
    try {
      pid = JSON.parse(await fs.readFile(file, "utf8")).pid;
    } catch {
      pid = null;
    }
    const alive = typeof pid === "number" && (await holderAlive(pid)) && pid !== process.pid;
    if (alive) continue;
    const sandboxId = entry.slice(0, -".lease".length);
    await fs.rm(file, { force: true });
    // The workspace belonged to the dead holder — deleting it is the lease
    // semantic. Nothing re-queues a claimed run: the record stays claimed
    // until the adapter's deadline settles it as an error.
    await fs.rm(path.join(runRoot, "runs", sandboxId), { recursive: true, force: true });
  }
}

// ── Exec ────────────────────────────────────────────────────────────────
function matchesPrefix(argv, prefix) {
  if (prefix.length === 0 || prefix.length > argv.length) return false;
  return prefix.every((token, i) => argv[i] === token);
}

// Repository-controlled children must never inherit the daemon's adapter bearer,
// GitHub token, cloud credentials, or arbitrary shell secrets. Provider keys
// below are intentional local-harness credentials, not daemon control tokens.
function childEnvironment(harness) {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "USER",
    "LOGNAME",
    "SHELL",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
  ];
  const providerKeys = {
    claude: ["ANTHROPIC_API_KEY"],
    codex: ["OPENAI_API_KEY"],
    opencode: ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"],
    agy: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  };
  return Object.fromEntries(
    [...allowed, ...(providerKeys[harness] ?? [])]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
}

function runProcess(argv, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    opts.onChild?.(child);
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGTERM");
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d) => {
      stdout = boundTail(stdout + d.toString(), MAX_STDOUT_TAIL_CHARS);
      opts.onStdout?.(d.toString());
    });
    child.stderr.on("data", (d) => {
      stderr = boundTail(stderr + d.toString(), MAX_STDERR_TAIL_CHARS);
      opts.onStderr?.(d.toString());
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${error.message}`.trim(), exitCode: -1, error });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: killed ? -2 : (code ?? -1), timedOut: killed });
    });
  });
}

/**
 * scopedExec's local twin: the envelope's allowlist decides, the receipts
 * carry the same {"command","exit"|"refused"|"thrown"} detail the sandbox
 * emits — T43's verify reads them identically.
 */
async function scopedLocalExec(argv, allowlist, opts = {}) {
  const command = shellJoin(argv);
  milestone("exec.invoked", receipt(command, {}));
  const allowed = allowlist.some((prefix) => matchesPrefix(argv, prefix));
  if (!allowed) {
    milestone("exec.settled", receipt(command, { refused: true }));
    return { stdout: "", stderr: "", exitCode: -1, refused: true };
  }
  const started = Date.now();
  const result = await runProcess(argv, opts);
  milestone(
    "exec.settled",
    result.exitCode < -1
      ? receipt(command, { thrown: true, ms: Date.now() - started })
      : receipt(command, { exit: result.exitCode, ms: Date.now() - started }),
  );
  return result;
}

// ── Envelope handling ───────────────────────────────────────────────────
function substitute(value, root) {
  return value.split(LOCAL_RUN_ROOT_TOKEN).join(root);
}

function errorResult(summary, exitCode = -1) {
  return {
    status: "error",
    exitCode,
    summary: boundTail(summary, 16_384),
    stderrTail: "",
    changedFiles: [],
    diff: "",
    files: [],
    signals: [...signals],
  };
}

async function collectResult(envelope, root) {
  const cloneDir = substitute(envelope.cloneDir, root);
  const status = await runProcess(["git", "-C", cloneDir, "status", "--porcelain", "-uall"]);
  if (status.exitCode !== 0) {
    return { error: `git status failed: ${status.stderr.slice(0, 500)}` };
  }
  const changedFiles = [];
  for (const line of status.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const spec = line.slice(3).trim();
    // rename lines read "old -> new"; the new path is what the PR writes.
    const filePath = spec.includes(" -> ") ? spec.split(" -> ").pop().trim() : spec;
    changedFiles.push(filePath);
    if (changedFiles.length >= 500) break;
  }
  // Stage everything (this workspace is disposable) so the diff covers
  // untracked files exactly like the checkpoint diff does in-sandbox.
  await runProcess(["git", "-C", cloneDir, "add", "-A"]);
  const diff = await runProcess(["git", "-C", cloneDir, "diff", "--cached", "--no-color"]);
  const files = [];
  let totalChars = 0;
  for (const filePath of changedFiles.slice(0, MAX_CAPTURED_FILES)) {
    const absolute = path.join(cloneDir, filePath);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_CHARS * 2) {
        files.push({ path: filePath, content: null, encoding: "utf8" });
        continue;
      }
      const content = await fs.readFile(absolute, "utf8");
      if (totalChars + content.length > MAX_TOTAL_FILE_CHARS) break;
      totalChars += content.length;
      files.push({ path: filePath, content, encoding: "utf8" });
    } catch {
      files.push({ path: filePath, content: null, encoding: "utf8" });
    }
  }
  return { changedFiles, diff: boundTail(diff.stdout, 2_000_000), files };
}

async function execute(envelope, claimToken) {
  const startedAt = Date.now();
  const root = path.join(runRoot, "runs", envelope.sandboxId);
  const cloneDir = substitute(envelope.cloneDir, root);
  const homeDir = substitute(envelope.homeDir, root);
  const env = childEnvironment(envelope.harness);
  for (const [key, value] of Object.entries(envelope.env)) {
    if (key === "LOCAL_ADAPTER_TOKEN" || key === "GITHUB_TOKEN" || key === "GH_TOKEN") continue;
    env[key] = substitute(value, root);
  }
  env.HOME = homeDir;

  const deadline = envelope.deadlineAt - startedAt;
  const remaining = () => Math.max(1, deadline - (Date.now() - startedAt));

  await writeLease(envelope.sandboxId);
  try {
    // 1. clone — git on the operator's PATH, operator's own git credentials.
    await fs.rm(cloneDir, { recursive: true, force: true });
    await fs.mkdir(cloneDir, { recursive: true });
    const clone = await runProcess(
      ["git", "clone", "--branch", envelope.baseBranch, envelope.repoUrl, cloneDir],
      { timeoutMs: Math.min(remaining(), 5 * 60 * 1000) },
    );
    if (clone.exitCode !== 0) {
      // Branch may not exist remotely; clone default then checkout.
      const fallback = await runProcess(["git", "clone", envelope.repoUrl, cloneDir], {
        timeoutMs: Math.min(remaining(), 5 * 60 * 1000),
      });
      if (fallback.exitCode !== 0) {
        return errorResult(`git clone failed: ${fallback.stderr.slice(0, 1000)}`);
      }
      const checkout = await runProcess(
        [
          "git",
          "-C",
          cloneDir,
          "checkout",
          "-B",
          envelope.baseBranch,
          `origin/${envelope.baseBranch}`,
        ],
        { timeoutMs: 60_000 },
      );
      if (checkout.exitCode !== 0) {
        return errorResult(
          `git checkout ${envelope.baseBranch} failed: ${checkout.stderr.slice(0, 500)}`,
        );
      }
    }

    // 2. setup ops — the same prefix allowlist the sandbox adapter applies.
    await fs.mkdir(homeDir, { recursive: true });
    // Subscription CLIs read auth from the run HOME. Copy those files
    // read-only. Never symlink the operator's ~/.claude or ~/.codex.
    await copyOperatorAuth(homeDir, process.env.HOME);
    for (const argv of envelope.setupCommands) {
      const resolved = argv.map((part) => substitute(part, root));
      const result = await scopedLocalExec(resolved, envelope.setupAllowlist, {
        cwd: cloneDir,
        timeoutMs: 60_000,
        env,
      });
      if (result.refused || result.exitCode !== 0) {
        return errorResult(
          `Home layout setup ${result.refused ? "refused by allowlist" : `failed (exit ${result.exitCode})`}: ${argv.join(" ")} ${result.stderr.slice(0, 500)}`,
        );
      }
    }

    // 3. config files — tokenized paths resolve under the run's home/work.
    for (const file of envelope.configFiles) {
      const target = substitute(file.path, root);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.contents);
    }
    milestone("config.written", `${envelope.configFiles.length} files`);

    // 4. the harness process. A session envelope drives Codex or Claude
    // through the session layer; older envelopes still exec argv.
    milestone("harness.started", envelope.harness);
    let run;
    if (envelope.session) {
      const { eventText, runSessionJob } = await import("./agent-harness.mjs");
      const texts = [];
      const session = envelope.session;
      const outcome = await runSessionJob({
        provider: session.provider,
        model: session.model,
        permissionMode: session.permissionMode,
        cwd: cloneDir,
        // Session JSONL stays under the run home. The worktree diff must not
        // pick up the log as a changed file.
        logDir: homeDir,
        prompt: envelope.task,
        env,
        checkpoints: true,
        emitStdout: false,
        ...(session.bin ? { bin: substitute(session.bin, root) } : {}),
        ...(session.binArgs
          ? { binArgs: session.binArgs.map((part) => substitute(part, root)) }
          : {}),
        ...(session.resumeThreadId ? { resumeThreadId: session.resumeThreadId } : {}),
        onChild: (child) => {
          activeHarnessChild = child;
        },
        onEvent: (event) => {
          const text = eventText(event);
          if (text) texts.push(text);
          const body = {
            sandboxId: envelope.sandboxId,
            claimToken,
            event: {
              type: event.type,
              text: text.slice(0, 500),
              ...(typeof event.patch === "string" && event.patch !== ""
                ? { patch: event.patch.slice(0, 100_000) }
                : {}),
            },
          };
          void post("events", body).catch((error) => {
            console.error(`shiba-local: event post failed: ${error.message}`);
          });
        },
        onApproval: async (request) => {
          await post("approval", {
            sandboxId: envelope.sandboxId,
            claimToken,
            request: {
              requestId: request.requestId,
              kind: request.kind,
              title: request.title,
              detail: request.detail,
            },
          });
          const deadline = Date.now() + Math.min(remaining(), 10 * 60 * 1000);
          while (Date.now() < deadline) {
            const polled = await post("approval", {
              sandboxId: envelope.sandboxId,
              claimToken,
              requestId: request.requestId,
            });
            if (polled.decision === "allow" || polled.decision === "deny") return polled.decision;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return "deny";
        },
        control: async () => {
          try {
            return await post("control", { sandboxId: envelope.sandboxId, claimToken });
          } catch {
            return {};
          }
        },
      });
      activeHarnessChild = undefined;
      run = {
        exitCode: outcome.exitCode,
        stderr: outcome.status === "completed" ? "" : outcome.summary,
        stdout: texts.join("\n"),
      };
    } else {
      const argv = envelope.argv.map((part) => substitute(part, root));
      run = await runProcess(argv, {
        cwd: cloneDir,
        env,
        timeoutMs: remaining(),
        onChild: (child) => {
          activeHarnessChild = child;
        },
        onStdout: (chunk) => process.stdout.write(chunk),
        onStderr: (chunk) => process.stderr.write(chunk),
      });
      activeHarnessChild = undefined;
    }
    milestone("harness.idle", `exitCode:${run.exitCode}`);
    const stderrTail = boundTail(run.stderr, MAX_STDERR_TAIL_CHARS);
    if (run.exitCode !== 0) {
      return {
        status: "error",
        exitCode: run.exitCode,
        summary: boundTail(
          `${envelope.harness} exited with code ${run.exitCode}. ${stderrTail.slice(-1000)}`.trim(),
          16_384,
        ),
        stderrTail,
        stdoutTail: boundTail(run.stdout, MAX_STDOUT_TAIL_CHARS),
        changedFiles: [],
        diff: "",
        files: [],
        signals: [...signals],
      };
    }

    // 5. collect — status + staged diff + file contents.
    const collection = await collectResult(envelope, root);
    if (collection.error) return errorResult(collection.error);
    milestone("collect.complete", `${collection.changedFiles.length} files`);

    const result = {
      status: "completed",
      exitCode: 0,
      summary: boundTail(
        run.stdout
          .split("\n")
          .filter((line) => line.trim() !== "")
          .slice(-20)
          .join("\n") ||
          `${envelope.harness} completed with ${collection.changedFiles.length} changed files.`,
        16_384,
      ),
      stderrTail,
      changedFiles: collection.changedFiles,
      diff: collection.diff,
      files: collection.files,
      signals: [...signals],
    };

    // 6. test command — allowlisted exactly like scopedExec; a refusal is
    //    evidence for the Worker's verify gate, never a daemon-side verdict.
    if (envelope.testCommand !== undefined && envelope.testCommand.length > 0) {
      const testArgv = envelope.testCommand.map((part) => substitute(part, root));
      const testRun = await scopedLocalExec(testArgv, envelope.execAllowlist, {
        cwd: cloneDir,
        env,
        timeoutMs: Math.min(remaining(), 5 * 60 * 1000),
      });
      if (!testRun.refused) {
        result.testEvidence = {
          command: shellJoin(envelope.testCommand),
          exitCode: testRun.exitCode,
          outputTail: boundTail(`${testRun.stdout}\n${testRun.stderr}`.trim(), 16_384),
        };
      }
      result.signals = [...signals];
    }
    return result;
  } finally {
    await releaseLease(envelope.sandboxId);
  }
}

// ── Fleet: pairing, machine identity, heartbeat ─────────────────────────
/** Names only — the fleet view shows pills, not version strings. */
function probeHarnesses() {
  return PROBED_HARNESSES.filter(
    (name) =>
      spawnSync(name, ["--version"], { timeout: 5_000, stdio: "ignore", env: childEnvironment() })
        .status === 0,
  );
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeConfig(config) {
  await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // mode only applies on create; re-pairing over an old file must tighten it too.
  await fs.chmod(configPath, 0o600);
}

async function localMachineId() {
  const file = path.join(runRoot, "machine-id");
  const existing = (await fs.readFile(file, "utf8").catch(() => "")).trim();
  if (existing !== "") return existing;
  const id = randomUUID();
  await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${id}\n`, { mode: 0o600 });
  return id;
}

async function pair(url, pairingToken) {
  workerUrl = url.replace(/\/+$/, "");
  let paired;
  try {
    paired = await post("pair", {
      pairingToken,
      hostname,
      platform,
      daemonVersion: DAEMON_VERSION,
      harnesses,
    });
  } catch (error) {
    fail(
      error.status === 401
        ? "pairing token expired, reused, or invalid — mint a new one in Remote Access."
        : `pairing failed: ${error.message}`,
    );
  }
  await writeConfig({ workerUrl, adapterToken: paired.adapterToken, machineId: paired.machineId });
  console.log(`shiba-local: paired as ${paired.machineId}; saved ${configPath}`);
}

function revoked() {
  fail("adapter token revoked; re-pair", EXIT_REVOKED);
}

async function heartbeat() {
  try {
    await post("heartbeat", {
      machineId,
      hostname,
      platform,
      daemonVersion: DAEMON_VERSION,
      harnesses,
      ...(activeRunId ? { activeRunId } : {}),
    });
    report({ state: "heartbeat", ok: true });
  } catch (error) {
    report({ state: "heartbeat", ok: false });
    if (error.status === 401) revoked();
    // Network blips are expected; the next tick retries.
    console.error(`shiba-local: heartbeat failed: ${error.message}`);
  }
}

const RESULT_ATTEMPTS = 4;

/** A finished run is expensive to lose: retry transient failures ~1s, 2s, 4s with jitter. */
async function postResult(body) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await post("result", body);
    } catch (error) {
      if (error.status === 401) revoked();
      const transient = error.status === undefined || error.status >= 500 || error.status === 429;
      if (!transient || attempt >= RESULT_ATTEMPTS || stopping) throw error;
      console.error(
        `shiba-local: result post attempt ${attempt} failed, retrying: ${error.message}`,
      );
      await new Promise((r) =>
        setTimeout(r, 1_000 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5)),
      );
      if (stopping) throw error;
    }
  }
}

// ── Loop ────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  await acquireLock();
  harnesses = probeHarnesses();
  if (args.connect) await pair(args.connect, args.pair);
  // Env vars win so the pre-pairing deployment-bearer setup keeps working unchanged.
  const config = await readConfig();
  workerUrl = (process.env.SHIBA_WORKER_URL ?? config.workerUrl ?? "").replace(/\/+$/, "");
  const adapterToken = process.env.LOCAL_ADAPTER_TOKEN ?? config.adapterToken ?? "";
  if (workerUrl === "")
    fail(
      "SHIBA_WORKER_URL is required (e.g. https://shiba.example.com), or pair with --connect/--pair.",
    );
  if (adapterToken === "")
    fail(
      "LOCAL_ADAPTER_TOKEN is required — the deployment's daemon bearer — or pair with --connect/--pair.",
    );
  AUTH = { Authorization: `Bearer ${adapterToken}` };
  machineId =
    (process.env.LOCAL_ADAPTER_TOKEN ? undefined : config.machineId) ?? (await localMachineId());
  await reapDeadWorkspaces();
  await heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS).unref();
  console.log(`shiba-local: polling ${workerUrl}/api/local as ${operator} (root ${runRoot})`);
  report({ state: "polling", machineId, harnesses });
  let idlePolls = 0;
  for (;;) {
    // gracefulStop owns settlement once stopping; never claim a run it will abandon.
    if (stopping) return new Promise(() => {});
    let claim;
    try {
      claim = await post("claim", { operator });
    } catch (error) {
      if (error.status === 401) revoked();
      console.error(`shiba-local: claim failed: ${error.message}`);
      if (args.once) process.exit(1);
      await new Promise((r) => setTimeout(r, Math.min(args.pollMs * 4, 30_000)));
      continue;
    }
    if (claim.envelope === null || claim.envelope === undefined) {
      if (args.once) {
        console.log("shiba-local: no pending runs.");
        process.exit(0);
      }
      idlePolls += 1;
      if (idlePolls % 200 === 0) console.log("shiba-local: still polling…");
      await new Promise((r) => setTimeout(r, args.pollMs));
      continue;
    }
    idlePolls = 0;
    const { envelope } = claim;
    console.log(
      `shiba-local: claimed ${envelope.sandboxId} (${envelope.harness}) — ${envelope.repoUrl}@${envelope.baseBranch}`,
    );
    report({
      state: "claimed",
      runId: envelope.sandboxId,
      harness: envelope.harness,
      repoUrl: envelope.repoUrl,
    });
    let result;
    activeRunId = envelope.sandboxId;
    heldClaim = { sandboxId: envelope.sandboxId, claimToken: claim.claimToken };
    try {
      result = await execute(envelope, claim.claimToken);
    } catch (error) {
      result = errorResult(
        `daemon error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      activeRunId = undefined;
    }
    if (stopping) return new Promise(() => {});
    try {
      await postResult({ sandboxId: envelope.sandboxId, claimToken: claim.claimToken, result });
      console.log(
        `shiba-local: settled ${envelope.sandboxId} — ${result.status} (exit ${result.exitCode})`,
      );
      report({
        state: "settled",
        runId: envelope.sandboxId,
        status: result.status,
        exitCode: result.exitCode,
        repoUrl: envelope.repoUrl,
        posted: true,
      });
    } catch (error) {
      console.error(`shiba-local: result post failed for ${envelope.sandboxId}: ${error.message}`);
      report({
        state: "settled",
        runId: envelope.sandboxId,
        status: result.status,
        exitCode: result.exitCode,
        repoUrl: envelope.repoUrl,
        posted: false,
      });
      // The DO holds the claim stale-window; the record reaps at 45min.
    }
    heldClaim = undefined;
    if (args.once) process.exit(result.status === "completed" ? 0 : 1);
  }
}

/**
 * Stop mid-run like a crash that still reports: kill the harness child,
 * settle the held claim best-effort inside a 3s budget, drop its lease,
 * then exit with the signal's code. Only the direct child is killed —
 * a process-group kill would need detached:true, a behavior change.
 */
let stopping = false;
async function gracefulStop(code) {
  if (stopping) return;
  stopping = true;
  const held = heldClaim;
  if (held === undefined) process.exit(code);
  activeHarnessChild?.kill("SIGTERM");
  try {
    await Promise.race([
      post("result", {
        sandboxId: held.sandboxId,
        claimToken: held.claimToken,
        result: errorResult("daemon stopped"),
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("stop budget exceeded")), 3_000),
      ),
    ]);
  } catch {}
  await releaseLease(held.sandboxId).catch(() => {});
  process.exit(code);
}
process.on("SIGINT", () => void gracefulStop(130));
process.on("SIGTERM", () => void gracefulStop(143));
await main();
