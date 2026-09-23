# Issue tracker: PLAN.md tasks

Work for this repo is tracked as tasks in `PLAN.md` at the repo root, not in GitHub Issues. Each task has an id `T<n>` (bugs are `B<n>`, gaps found by verification are `G<n>` in `VERIFICATION_PLAN.md`). The `§2.0` status table in `PLAN.md` is the authoritative open/done list.

## Conventions

- A task is a `### T<n> · <title>` section under its phase heading in `PLAN.md`.
- State lives in the `§2.0` table: **Done**, **Blocked**, or absent (open). Add a row when state changes; do not edit the task body to record state.
- Evidence for "done" is a dated entry in `VERIFICATION.md`. A task with no entry there is not done, whatever the table says.
- Specs for new work go in `PLAN.md` as a new `T<n>` section, or in `.scratch/<feature>/spec.md` when they are too long for the plan.
- Triage state, when a skill needs it, is a `Status:` word after the task title in the `§2.0` table (see `triage-labels.md`).

## When a skill says "publish to the issue tracker"

Append a `### T<n>` section to the matching phase in `PLAN.md` and a row to the `§2.0` table. Use the next unused number.

## When a skill says "fetch the relevant ticket"

Read the `### T<n>` section and its `§2.0` row. Commit messages reference tasks as `T6`, `B10`, `G3`; grep `PLAN.md` and `VERIFICATION_PLAN.md` for the id.

## Wayfinding operations

Used by `/wayfinder`. Falls back to local markdown: map at `.scratch/<effort>/map.md`, one child ticket per file at `.scratch/<effort>/issues/NN-<slug>.md` with `Type:`, `Status:`, and `Blocked by:` lines near the top. Resolve by appending `## Answer`, setting `Status: resolved`, and adding a pointer to the map.

## PRs as a request surface

Off. External PRs are not part of the triage queue.
