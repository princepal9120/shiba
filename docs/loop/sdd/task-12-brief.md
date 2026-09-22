### Task 12 — agents sidebar section + unified Approvals tab
**Files:** `src/dashboard/components/SessionsSidebar.tsx`,
`src/dashboard/components/WorkspacePanel.tsx` (Approvals section),
`src/dashboard/types.ts`, `src/dashboard/app.tsx`, `src/index.ts`
- `GET /api/agents` already exists — extend response to include registered
  agent principals (from token store list via internal route) + connection
  state; render an "Agents" group in SessionsSidebar below "Active": name,
  live dot, scope summary tooltip.
- Approvals tab: single list of all pending approvals (runs + email + any
  kind field), each card: agent name, tool/action, args preview, Approve /
  Reject wired to existing `/api/approvals` resolve path.

