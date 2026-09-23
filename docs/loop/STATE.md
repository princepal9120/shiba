# Loop State — Megaplan: Email Inbox + Memory + UI

Session: https://app.devin.ai/sessions/7261650508fa4a628628eed12636bf13
Branch: `megaplan/email-memory-ui` (based on `devin/1790076195-bezalel-dashboard-theme`, PR #7)
Plan: `docs/plans/megaplan-email-memory.md`

## Goal

Working (code-complete) email inbox + long-term memory + dashboard UI in the
existing Shiba stack, behind an MCP gateway with scoped per-agent tokens and
approval-gated destructive ops, delivered as one PR. Deploy-time provisioning
(DNS, wrangler resource creation, deploy) is explicitly out of scope → triage.

## Done definition

- [ ] All 13 tasks implemented on `megaplan/email-memory-ui`
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green after every task
- [ ] Final whole-branch review complete; fix wave applied
- [ ] One PR open against `main`, following PR template
- [ ] Triage list below in the PR body so nothing is lost

## In progress

PARALLEL LANES: lane A (backend T7-T10) + lane B (UI T11-T13) ran concurrently. T7, T11, T13 DONE w/ controller adjudications; T8 exhausted → adjudicated (bank-race 409 @84d5ab1); T9 impl in flight; T10 next on lane A. T14 DONE. ALL 14 tasks complete; final whole-branch review in flight before the PR.

## Phases (SDD task → review → fix loop)

| Task | Phase | Status |
|---|---|---|
| T1 mailbox-store core | 1 | DONE (5 fix rounds + controller fix @ 6d531cf) |
| T2 MailboxDO + bindings | 1 | DONE (1 fix round) |
| T3 email() handler + MIME | 1 | DONE (3 fix rounds) |
| T4 tokens + audit writer | 2 | DONE (1 fix round) |
| T5 McpGateway + /mcp route | 2 | DONE (1 fix round) |
| T6 email MCP tools (13) | 3 | DONE |
| T7 email approval bridge | 3 | DONE (exhausted → adjudicated @395fcaf) |
| T8 MemoryDO + Vectorize | 4 | DONE (exhausted → adjudicated @9e89c15) |
| T9 memory MCP tools (4) | 4 | in flight |
| T10 session distillation | 4 | pending |
| T11 Inbox + Memory tabs | 5 | DONE (exhausted → adjudicated @bbe78be) |
| T12 sidebar agents + unified approvals | 5 | DONE |
| T13 audit view + retention | 5 | DONE |
| T14 visual-consistency pass (landing + dashboard) | 5 | DONE (1 fix round) |

## Verify (cheap signals)

`pnpm typecheck && pnpm lint && pnpm test` after every phase;
`pnpm build:dashboard` after phase 5.

## Rulings (decisions taken during the loop)

1. **Design tokens**: megaplan cites teal `#0B9F95` + Space Grotesk from an old
   design.md, but the dashboard now ships the Bezalel navy/cream/Geist system
   (PR #7, this branch's base). New panels follow the CURRENT system; accent
   stays navy `#0000a8`. Teal spec is superseded.
2. **Base branch**: branched from the Bezalel restyle branch (not main) so UI
   tasks build on the new design system; when PR #7 merges, the megaplan PR
   diff shows only megaplan commits.
3. **Alchemy**: megaplan shows `alchemy.run.ts` snippets, but the repo evaluated
   Alchemy and deploys via `wrangler.jsonc`. All binding wiring goes in
   wrangler.jsonc.
4. **T6/T7 ordering**: T6 defines the `queueEmailApproval` seam; T7 implements
   it. If scheduling prefers, T7's module may land first — the contract is the
   function signature in the plan.
5. **McpAgent**: `agents@0.23.0` ships `McpAgent` from `agents/mcp` — gateway
   extends it rather than hand-rolling MCP protocol.

## Triage inbox (human/user actions — not code blockers)

- [ ] `wrangler d1 create shiba-audit` → paste `database_id` into wrangler.jsonc
- [ ] `wrangler kv namespace create AGENT_TOKENS` → paste namespace id
- [ ] `wrangler r2 bucket create shiba-attachments`
- [ ] `wrangler vectorize create shiba-memory --dimensions=768 --metric=cosine`
- [ ] `wrangler vectorize create-metadata-index shiba-memory --property-name=agent --type=string` (required for `?agent=` scoped recall)
- [ ] Enable Email Routing on the chosen domain + MX records (user-side DNS)
- [ ] Confirm Email Sending (send_email binding) availability on the account
- [ ] `wrangler deploy` — outward-facing, needs explicit user approval
- [ ] Choose agent mailbox addresses and register them
- [ ] Generate first agent tokens (`admin:tokens` scope holder) once deployed

## Hard stops

- Same check red 3x in a row → stop loop, report
- Same failure class on 2 consecutive tasks → stop, report
- Scope creep beyond plan → log here, don't expand
