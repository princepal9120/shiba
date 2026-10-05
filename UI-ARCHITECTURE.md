# UI architecture: target shape

For `ai-intern` (shiba). Measured at `980fa2c`; t3code structure read from
`main` the same day via `gh` (agent-reach dev backend).

Two docs this sits between: `ARCHITECTURE-AS-BUILT.md` (what exists) and
`INFRA-AUTH-HARNESS-MONOREPO.md` (backend seams). This one is the client.

---

## 1. Where the UI actually is today

8,104 LOC across 24 components. Two route files. The finding that matters:

| Component | LOC | Surface |
|---|---|---|
| `InboxTab` | 1126 | email |
| `VMInspector` | 885 | containers |
| `WorkspacePanel` | 681 | repos/workspaces |
| `MemoryTab` | 649 | memory + Vectorize |
| `OnboardingModal` | 531 | first-run |
| `AutomationsView` | 424 | triggers |
| `AgentsView` | 417 | providers/models |
| `SessionsSidebar` | 362 | run list |
| `DashboardView` | 359 | overview |
| `RunRegistryView` | 343 | run history |
| `AppNavRail` | 326 | navigation |
| `StepTimeline` | 287 | run progress |
| `Tooltip` | 295 | — |

`routes/app.tsx` is 30 lines and renders `<App />`. All navigation state is
inside `App.tsx` and the components. That is the shape to change.

**Five components over 600 LOC, each owning its own data fetching, own state, and
own rendering.** `InboxTab` at 1126 is the worst: it is a list, a detail pane, a
composer, and a search, in one file.

---

## 2. The two structural problems

**A. No route tree.** Two route files means TanStack Router is doing nothing.
`AppNavRail` swaps views by component state, so there is no URL for a run, no
deep link into a diff, no browser back, and no refresh-in-place. For a system
whose entire value is "review this diff and approve or reject it," a
shareable, refreshable URL per run is table stakes, not a nice-to-have.

**B. No shared data layer.** Each of the 24 components fetches its own. `ApprovalCard`
(87 LOC) and `ApprovalsView` (203 LOC) both load approval state, and the reviewer's
mental model is that a run's approval status is one fact. Today it is at least two
fetches in at least two places, which is precisely how a stale approval badge
appears.

---

## 3. Target shape

Three layers, one direction of dependency. Nothing below imports anything above.

```
┌──────────────────────────────────────────────────────────────────┐
│  routes/          file-based routes, one file per surface         │
│                   /runs  /runs/$runId  /approvals  /inbox  ...    │
├──────────────────────────────────────────────────────────────────┤
│  features/        one folder per domain, owns its data + view     │
│                   runs/ approvals/ inbox/ memory/ automations/    │
│                   agents/ workspace/ gates/                        │
├──────────────────────────────────────────────────────────────────┤
│  ui/              primitives only. variant + size props.          │
│                   No data fetching. No domain knowledge.          │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                    client-runtime/  (new package)
        connection supervisor · typed RPC · subscription cache
```

Rules, each one a thing t3code does that this repo does not:

1. **`ui/` components take `variant` and `size`.** They never accept a
   `className` for looks. A generic look is a new variant; a look that belongs to
   one feature stays in that feature's folder.
2. **A feature owns its fetch.** `features/runs/` loads runs. Nothing else calls
   the runs endpoint. One owner per fact.
3. **Cross-feature reads go through the client runtime**, never through a second
   component's props. That is what stops the double-fetch.
4. **Layout classes live on the parent.** Width, flex, margin, position are the
   parent's job, not the primitive's.

---

## 4. Route tree

```
/                          redirect → /runs
/runs                      run list + composer          (was DashboardView + TaskComposer)
/runs/$runId               the run                      ← the deep link that must exist
  ?tab=timeline            step timeline, streaming
  ?tab=diff                diff viewer, per-file
  ?tab=conversation        messages + reasoning + tool calls
  ?tab=terminal            pty, when the harness exposes one
  ?tab=proof               screenshot, test output, preview URL
/runs/$runId/approvals/$approvalId    the review surface
/approvals                 queue across all runs
/inbox                     email          (InboxTab, split)
/inbox/$threadId
/memory                    facts + recall (MemoryTab)
/automations               triggers, budget, kill switch
/agents                    providers, models, auth status  (AgentsView)
/workspace                 repos, scopes, checkout        (WorkspacePanel)
/runs/$runId/containers    VMInspector, moved under the run it belongs to
/gates                     quality gates
/settings/*                appearance, auth, danger zone
```

Two moves worth calling out.

**`VMInspector` moves under `/runs/$runId/containers`.** A container has no meaning
outside the run that created it. 885 LOC currently reachable from a global nav
item is 885 LOC of context the user has to reconstruct by hand.

**Tabs are URL params, not local state.** `?tab=diff` is shareable, survives
refresh, and works with browser back. For a review-and-approve workflow that is the
difference between "send my teammate the link" and "screenshot the terminal".

---

## 5. The client runtime

This is the piece t3code has and this repo lacks, and it is the prerequisite for
everything else. New package: `packages/client-runtime`.

```
packages/client-runtime/src/
  connection/
    supervisor.ts     one retry owner per environment
    registry.ts       environments, cached data, credential lifetime
    resolver.ts       endpoint resolution
    wakeups.ts        offline / auth-failure wake signals
  rpc/
    session.ts        open socket, build typed client, readiness
    client.ts         resolve against current session at execution time
  state/
    runs.ts           run list + detail, subscription vs cache lifetime
    approvals.ts      one owner for approval state
  authorization/
    service.ts        current credentials for HTTP
    tokenStore.ts     refresh without replacing a healthy socket
```

Five properties, each one a bug this repo cannot currently have because it does not
have the abstraction:

**One retry owner per environment.** Today every component that fetches can retry.
Several components fetching the same environment means several retry loops racing.
The supervisor owns backoff; components just await.

**Opening a socket is not readiness.** A session is ready when initial server config
arrives, not when the socket opens. Without this you get a spinner that lies.

**Transport health and data freshness are separate states.** A failed subscription
can coexist with a healthy socket. Labelling that "reconnecting" promises a retry
that will never come. This is the "lying spinner" class of bug and it is worth the
extra state.

**Subscription lifetime ≠ cache lifetime.** Mounted consumers share one live stream,
stopped when the last unmounts. The cache keeps state plus its replay cursor
together, and only after an update finishes. Retain the pair, never one without the
other.

**Credential refresh must not replace a healthy socket.** If refreshing a token
resumes a working conversation, that is a visible bug. Refresh belongs to the HTTP
operation; the socket outlives it.

---

## 6. State: server state vs UI state

The line most dashboards get wrong.

| Kind | Owner | Examples |
|---|---|---|
| Server state | client runtime, cached, refetchable | runs, approvals, messages, diffs, receipts |
| Durable UI state | URL | selected run, selected tab, selected file, search query |
| Ephemeral UI state | component | open popover, hover, draft text |
| Auth/connection | client runtime | socket state, credentials, environment list |

Anything a user would want to share or survive a refresh on is **server state or URL
state**, never component state. `InboxTab` almost certainly keeps its selected
thread in component state today, which means no link to a conversation.

---

## 7. Rendering the run: the part that matters most

`StepTimeline` (287 LOC) currently renders progress from receipt strings, because
`harness.parseEvent` returns a bounded string. Everything downstream is parsing text
back into structure. Fixing the harness interface (Phase 4 and 7 in
`ARCHITECTURE-IMPORT-PROMPT.md`) unblocks this directly.

```
run view
├── header          status · harness · model · runtime · duration
├── approval gate   prominent while pending. frozen input, diffable.
│                   this is the product. it gets the best pixels on the page.
├── timeline        typed events, streaming, not polling
│   ├── assistant   text deltas as they arrive
│   ├── tool call   name, target, duration, approval badge
│   ├── command     scoped exec: argv, exit code, output tail
│   ├── checkpoint   captured / reverted
│   └── approval    requested → answered, with who and when
├── conversation    messages, reasoning, collapsed by default
├── diff            per-file, staged/unstaged, +/- , binary guard
├── proof           screenshot · test output · preview URL
└── actions         steer · stop · revert · open PR · rerun
```

Three rules for this view specifically:

**The approval card is the primary object, not a modal.** t3code and Roomote both
put it inline in the timeline. A modal interrupts; an inline card is part of the
record of what was approved and what happened next.

**Streaming means streaming.** If the transport delivers deltas, render deltas.
Do not poll a run endpoint and re-diff. Polling is what makes a progress bar lie.

**A stopped run shows why, in the timeline, not in a toast.** Toasts vanish.
The run record is where someone actually looks.

---

## 8. Component budget

Today's five-over-600 files are the problem, not the total. Target per component:

| Concern | Budget | Why |
|---|---|---|
| data + logic + render | 300 LOC | past this, split the data out |
| pure render | 500 LOC | a big diff view is fine if it fetches nothing |
| anything above | split | `InboxTab` at 1126 is 4 components |

`ui/` primitives: no `className` for looks, no fetching, no domain types. If a
primitive imports from `features/`, it is not a primitive.

---

## 9. Order

Each step is independently shippable and improves the product on its own.

1. **Add `packages/client-runtime`** with the supervisor and the five properties.
   Nothing visual changes yet. Everything after this is safe.
2. **Real route tree.** Convert `AppNavRail` state into routes. Immediate win:
   deep links, back button, refresh. Do this before any component work so new
   components land in the right place.
3. **Move approval state to one owner.** Kill the double-fetch between
   `ApprovalCard` and `ApprovalsView`. Small, and it removes a whole bug class.
4. **Split the five oversized components**, largest first: `InboxTab` → thread
   list + thread view + composer + search. `VMInspector` under `/runs/$runId`.
5. **Typed harness events** (backend Phases 4 and 7 first). Then the run view
   renders structure instead of parsing strings.
6. **Streaming transport.** Deltas end polling. Only worth doing once 5 lands,
   because typed events are what make streaming renderable.
7. **Proof tab.** Screenshot, test output, preview URL, on the run. Requires the
   scoped executor (backend Phase 6) to have anything to show.

Do not do, without a trigger: a state-management library (the client runtime is
the answer, and adding Redux/Zustand on top is a second source of truth), a
component library beyond `ui/`, or a design-system extraction before `ui/` has
more than the primitives it needs.

---

## 10. What to copy from t3code, concretely

Read from `main` 2026-09-27. Not to adopt wholesale, to steal three specific things.

**Folder-per-feature with a strict `ui/` boundary.** t3code's `apps/web/src` runs
143 files under `components/chat`, 140 under `components/settings`, 74 under
`components/pullRequest`, 63 under `components/preview`, 55 under `components/ui`.
The domain folders dwarf the primitive folder, which is the correct ratio. This
repo inverts it: 21 feature components and one `ui/` directory.

**A `client-runtime` package shared across surfaces.** t3code runs `apps/web`,
`apps/desktop`, and `apps/mobile` off one `packages/client-runtime` (259 files),
with `connection/supervisor.ts`, `connection/registry.ts`, `rpc/session.ts`, and
`authorization/service.ts` as the load-bearing pieces. The rule that makes it work:
*React components never construct a transport, a retry loop, or an RPC client.*
This repo has one surface today, so the immediate value is the five properties in
§5, not the multi-surface reuse.

**Dumb components, one state owner.** t3code's rule is that complexity belongs at
the adapter boundary, orchestration stays pure, and UI stays dumb. The dashboard
renders a read model. It does not compute whether a run is approvable.
