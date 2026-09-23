# shiba-ai-coworker

Self-hosted, approval-gated coding agent on Cloudflare Workers + Sandbox. Plan and status: `PLAN.md`. Product contract: `spec/GOAL.md`. Verification evidence: `VERIFICATION.md`; open gaps and how to check them: `VERIFICATION_PLAN.md`.

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
npx wrangler deploy --dry-run --config backend/wrangler.jsonc   # needs Docker daemon running
```

## Agent skills

### Issue tracker

Tasks are `T<n>` sections in `PLAN.md`; state lives in its §2.0 table, evidence in `VERIFICATION.md`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, recorded as a `Status:` word in the §2.0 table. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the root, with `spec/GOAL.md` as standing constraints. See `docs/agents/domain.md`.
