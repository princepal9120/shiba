# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root (single-context layout).
- **`apps/web/docs/adr/`**: read ADRs that touch the area you're about to work in.
- **`spec/GOAL.md`**: the product contract. Treat its constraints (single-tenant, no invented prices, no prose scraping at the child boundary) as standing ADRs.

If `CONTEXT.md` or `apps/web/docs/adr/` don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── apps/web/docs/adr/
│   └── 0001-<slug>.md
├── spec/GOAL.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (issue title, refactor proposal, hypothesis, test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary avoids. Established terms already in use: *orchestrator*, *child agent*, *harness*, *run*, *approval gate*, *egress*, *automation*, *burst*.

If the concept you need isn't in the glossary yet, either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR or a `spec/GOAL.md` rule, surface it explicitly rather than silently overriding:

> _Contradicts GOAL.md (single-tenant), but worth reopening because…_
