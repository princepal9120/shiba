# Infra, auth, harness, monorepo: measured assessment

Measured at commit `980fa2c`, 2026-09-27. Companion to `ARCHITECTURE-AS-BUILT.md`.
Read that first for topology and the module map.

---

## 1. Infra

### What exists

`alchemy.run.ts`, 316 lines, primary deploy. `apps/backend/wrangler.jsonc` is the
rollback path. Both declare the same stack, and live stages pin resource names so
the first alchemy deploy **adopts** wrangler-managed resources in place rather
than replacing them. That is the single best decision in the infra layer and it
should stay.

Stage handling is explicit and correct:

```
workerName    = live ? "shiba-ai-coworker" : `shiba-ai-coworker-${stage}`
containerName = live ? "shiba-ai-coworker-sandbox" : `...-${stage}`
resSuffix     = live ? "" : `-${stage.replaceAll("_","-")}`
```

`secrets(names)` and `configVars(names)` helpers keep the two categories separate,
which is exactly right: a secret is never allowed to drift into a var.

`DashboardAccess` and `MachineBypass` are conditional on `accessEnabled`, which
requires live stage **and** a workers subdomain **and** a non-empty
`ACCESS_EMAILS`. Fail-closed by construction: no Access config means no Access
binding, and the explicit bypass list is then the only path.

### Dockerfile

`apps/backend/Dockerfile`, base `cloudflare/sandbox:0.12.9-opencode`, pinned to the
npm version. Five CLIs installed globally at fixed versions with `--version`
assertions baked into the same `RUN`, so a broken pin fails the build rather than
the run:

```
opencode-ai@1.18.31  @anthropic-ai/claude-code@2.1.277
@openai/codex@0.155.0  @xai-official/grok@1.0.41
```

Devin and procoder are checksum-verified against published manifests with
per-arch sha256 and a `case` on `uname -m` that exits on unknown arch. That is the
right level of rigor for third-party binaries.

`EXPOSE 4096` is the only port, and it matches the container proxy.

### Infra findings

**1. The container is the deploy unit, and the Dockerfile is the coupling point.**
Five CLIs in one image means every harness bump rebuilds and re-pushes an image
carrying four unrelated binaries. The comment already says this ("Bump requires
the same T10 pass"), so the cost is known. It is acceptable at five. At ten it
becomes the dominant deploy cost, and per-harness image variants become worth it.
Do not pre-optimize this now; record the threshold.

**2. `max_instances: 5` is a hard ceiling on throughput.** Five concurrent runs,
full stop. That is a product-visible number and it is currently only in
`wrangler.jsonc`. It belongs in `ARCHITECTURE.md` §4 and in any user-facing
capacity statement, because "how many tasks can run at once" is the first
question anyone asks.

**3. `wrangler deploy --dry-run` requires a running Docker daemon and currently
fails without one.** `PLAN.md:50` logs it. It means the documented verification
gate in `CLAUDE.md` is not runnable on a clean machine. Either make the gate
explicitly two-tier (dry-run optional, typecheck/lint/test/build mandatory) or
document the Docker prerequisite at the top of `CLAUDE.md`. Right now the gate
looks unconditional and silently is not.

**4. `WORKER_HOSTNAME` empty disables PR screenshots.** Capture fails safe and
never fails the run, which is the correct failure mode. But it means T33 is
effectively dark on any deploy that has not set it, and nothing surfaces that
except a comment in a JSONC file.

---

## 2. Auth

Five surfaces, 974 LOC total.

| File | LOC | Mechanism |
|---|---|---|
| `access-jwt.ts` | 43 | Cloudflare Access JWT, RS256, remote JWKS |
| `agent-tokens.ts` | 270 | Hashed bearer tokens in KV, scopes, revocation |
| `mcp-gateway.ts` | 324 | Scope check → handler → audit |
| `audit.ts` | 153 | D1 append, arg hashes never args |
| `security.ts` | 184 | `boundTail`, `redactSecrets` |

### What is genuinely good

**`access-jwt.ts` is the tightest code in the repo.** The issuer regex
`/^https:\/\/[a-z0-9]+\.cloudflareaccess\.com$/` exists because the JWKS URL is
derived from the token's own `iss`, which would otherwise be attacker-chosen. That
is a real vulnerability class closed in one line, and the comment names it. The
JWKS cache is bounded at 4 with a clear, and `withVerifiedAccessIdentity` **deletes**
the header when verification fails rather than passing through whatever the client
sent. Fail-closed, correctly.

**`agent-tokens.ts` never stores a raw token.** Format `shb_<16-hex>_<48-hex>`,
shape-checked *before* any KV read, stored as `tok_<sha256hex>`. A KV dump yields
nothing usable. The KV read **fails closed**: an outage resolves to `null`, a
miss, so a store failure denies rather than admits. Parse is hand-rolled with an
explicit comment that KV's `type: "json"` throws on malformed input instead of
returning null. Each of those is a decision someone already got wrong once.

**`mcp-gateway.ts` dispatches `requireScope` → handler → `audit` and never
throws.** An unknown tool name is *still audited*, so a probe for a nonexistent
tool leaves a trace. That is the detail most implementations miss.

### Auth findings

**1. `/mcp` is the only bearer surface and it is the weakest link by design.**
`PLAN.md §17.3` T29 already scopes OAuth 2.1 + PKCE at roughly 8h, additive, with
the gate provably unchanged. It remains the unblocker. Nothing here needs
rearchitecting; it needs building.

**2. Token revocation is a KV write with no propagation guarantee.** `revokeToken`
writes a tombstone. A request already in flight, or one whose token was verified
microseconds earlier, completes normally. For an approval-gated system that is
probably acceptable, but it should be a stated property rather than an accident.
Worth one line in `ARCHITECTURE.md` §5.

**3. There is no rate limit on token verification.** `verifyToken` does a KV read
per request. KV has a read quota, and an unauthenticated flood against `/mcp` is a
quota-exhaustion vector. Cloudflare WAF or a simple per-IP limiter in front of
`/mcp` closes it. Small, cheap, worth doing before OAuth lands.

**4. `MCP_PRINCIPAL_HEADER` defense depends on every caller remembering to strip
it.** `principalFor` reads the header; the Worker injection is the only thing that
makes it trustworthy. A new ingress path that forgets the strip is a
privilege-escalation bug. Make the strip unconditional and central rather than
per-route. §17.3 already requires a test for this; make it a lint rule too.

**5. Audit stores arg hashes, not args.** Correct for privacy, and it means an
audit reader can prove two calls were identical but cannot see what was asked.
That is the right trade for a system that handles customer repos. Just be
explicit that it is a trade, because "we logged it" reads stronger than it is.

---

## 3. Harness

### As built

`harness/types.ts` defines the seam. `harness/index.ts` is the registry with the
runnability gate. Seven adapters, five runnable.

```ts
interface AgentHarness {
  name; supportedProviders;
  egressHosts(model): string[];      // selected harness's hosts only
  configFile(input, sandboxId): HarnessConfigFile | null;
  env(input, configPath): Record<string, string>;   // dummy key only
  buildArgv(input, workdir): string[];
  parseEvent(line): string | null;                 // throws on error envelopes
}
```

The design is right in three ways worth naming:

**`egressHosts` is per-harness, never a union.** `allowedHostsFor` in
`harness/index.ts` composes exactly one harness's hosts with `GIT_EGRESS_HOSTS`.
Five harnesses in one image, five different egress policies, deny-by-default
preserved.

**Error envelopes throw.** Every parser throws `*ErrorEvent` on an error record
rather than returning text. That is what makes "error is never reported as
completed" structural instead of a convention.

**`resolveHarness` refuses before approval.** `SANDBOX_HARNESS_NAMES` excludes
cursor and antigravity, and the check runs at selection time, so an invalid
harness never reaches the container. The reason is documented and correct:
cursor's API-key→token exchange stores tokens in the container and cannot hold the
dummy-key invariant.

### Harness findings

**1. The interface cannot express capability.** There is no way for a harness to
say "I cannot resume" or "I emit no tool calls" or "I cannot run tests". So far
this is handled by exclusion lists, which do not compose: adding a sixth harness
means editing `SANDBOX_HARNESS_NAMES`, and the UI cannot grey out anything. This
is the `capabilities()` addition from `ARCHITECTURE-IMPORT-PROMPT.md` Phase 4 and
it is the single highest-leverage harness change.

**2. `parseEvent` returning a bounded string loses structure.** Progress is a
string, so the dashboard renders a step timeline from strings rather than typed
events. Deltas, tool calls, token usage, and rate-limit resets all collapse into
one channel. A discriminated event union per harness would fix the UI and make
Phase 3's typed receipts possible. `parseEvent` becomes `parseEvent(line): HarnessEvent`.

**3. Nothing can execute a command.** `--allowedTools` and fixed argv mean no
harness can run the project's tests, so no harness can verify its own work. That is
the scoped-executor phase, and it is the prerequisite for honest verification.

**4. `configFile()` returns `null` for five of seven harnesses.** Fine today,
because all five are env-configured API-key paths. It stops being fine the moment a
harness needs a profile or a credential file, which is exactly what the broker
work requires. Get the interface right before that lands.

**5. Version pinning is duplicated in two places and documented once.** Dockerfile
pins the CLI versions, `harness/catalog.ts` mirrors them, and the Dockerfile comment
says bump both. Two sources of truth with a prose reminder is one source of truth
and a hope. Generate the catalog from the Dockerfile, or assert equality in a test.
Cheap, and it removes a whole class of "works on my machine" harness bugs.

---

## 4. Turbo and the monorepo

### As built

```
apps/backend     Worker      wrangler dev :8788
apps/frontend    React       vite
apps/web         Astro       astro check
packages/shared  @shiba/shared  zod only, no cloudflare:*, no DOM
```

Root scripts gate everything through turbo: `pnpm typecheck && pnpm lint && pnpm
test && pnpm build`. `turbo.json` declares six tasks.

`packages/shared` is the best-designed package in the repo. Its own description
states the constraint: *"Pure TypeScript + zod only — no cloudflare:*, agents, or
DOM dependencies."* That single sentence prevents the three worst monorepo
failures, and it should be enforced rather than trusted.

### Turbo findings

**1. `typecheck`, `test`, and `lint` all have `"cache": false`.** Only `build`
caches. That means the three tasks you run most often do full work every time, on
every workspace, even when nothing changed. The gate gets slower as the repo grows
and you get no signal about which package is actually slow.

`typecheck` and `lint` are almost always cacheable in practice: emit no artifacts,
depend only on inputs. `test` is cacheable too, though it may need
`persistent: false` plus an explicit `cache: false` escape for live tests. Turn
caching on for `typecheck` and `lint` first, measure, then decide on `test`.

`turbo.json` uses the modern `tasks` key, which is current for turbo 2.10. Good.

**2. `build` outputs include `"../../public/**"`.** A relative path escaping the
package directory. Turbo hashes outputs per package, so an output outside the
package is at best ignored and at worst corrupts another package's cache entry.
Either the build genuinely writes there, in which case it belongs to a root task,
or the glob is wrong. Worth checking, because it is the kind of thing that
produces unexplainable stale-cache behavior.

**3. Root `tsconfig.json` typechecks everything as one project.** `include` spans
`packages/shared/src`, `apps/backend/src`, `apps/backend/test`,
`apps/frontend/src`, and `alchemy.run.ts`. There are no per-package tsconfigs
(`apps/backend/tsconfig.json` does not exist; backend's typecheck is
`tsc --noEmit -p ../../tsconfig.json`).

Consequences: no project references, so no incremental typechecking, so every
`typecheck` run re-parses all 21,330 backend LOC plus the frontend. Turbo cannot
cache per-package typecheck results because there is one project. And the
`paths` block exists solely to paper over React type resolution across the
workspace.

This is the main monorepo debt. Project references with per-package tsconfigs give
you incremental builds and make package boundaries real, because a package that
imports outside its `references` fails to build. The `paths` hack disappears once
each package resolves its own deps.

**4. No `knip`.** Peer agent products like t3code run it. With one root tsconfig and a barrel
in `@shiba/shared`, unused exports and dead files are invisible. `knip` needs a
per-package setup to be accurate, so it lands after item 3.

**5. `apps/frontend` has 2 route files and 21 components.** Everything is in
components, routing is nearly flat. Not a monorepo issue, but it means
`app.tsx` is likely the real router and the `routes/` convention is not earning
its keep. Either commit to file-based routing or stop pretending.

**6. One package is not enough for a long time, and that is fine.**
`packages/shared` with a single `.` export is correct today. Do not split it
until a second consumer with a genuinely different dependency profile appears. The
barrel is the thing to watch: a single `.` export pulling in every contract means
importing one type pulls the whole package, which will eventually force the split
anyway. Subpath exports (`@shiba/shared/runs`, `@shiba/shared/receipts`) cost
nothing now and make the later split mechanical.

---

## 5. Recommended order

Cheap and independent, do first:

1. Enable turbo caching for `typecheck` and `lint`. Measure before and after.
2. Add `knip`. It will find real dead code immediately.
3. Fix or remove the `../../public/**` build output glob.
4. Add a per-arch CLI version assertion test: Dockerfile pins must equal
   `harness/catalog.ts`.
5. Rate-limit `/mcp` before it takes OAuth.

Structural, plan properly:

6. Per-package tsconfigs with project references. Biggest monorepo win.
7. `capabilities()` on `AgentHarness`, then `parseEvent` returning a typed union.
8. Scoped command executor, so verification becomes possible.
9. Split `index.ts` route branches into per-surface modules. It is 1677 LOC and
   holds the auth logic that invariant 5 says must stay per-surface anyway, so
   this improves the security posture and the file at the same time.
10. Broker work per `BROKER-ARCHITECTURE.md`, after 7 and 8, because it depends on
    a harness interface that can express capability and a runtime that can execute.

Do not do, without a trigger: splitting `packages/shared`, per-harness images,
adding a second repo provider, multi-tenancy.
