# Layouts — ai-intern

The landing page (`/`) has NO shared layout component — `web/src/pages/index.astro` is a full `<!DOCTYPE html>` document. Its header and footer are inline. The docs site uses Starlight's built-in layout (not source-controlled here). The dashboard is a React SPA with its own shell.

## Landing Header (inline in index.astro, lines ~285-314)

Sticky top header, `z-50`, `border-b border-neutral-800/80`, `bg-black/95 backdrop-blur-md`, low-opacity brick-pattern `::after` overlay.

Structure: `max-w-7xl` container, flex row (col on mobile):
- LEFT: logo link `/` → `pet-logo.png` in 10x10 circle (white bg, teal-500/50 border, hover scale-105) + stacked text: `SHIBA` in Bebas 2xl white + `THE BEST AI SOFTWARE ENGINEER` in DM Mono 10px neutral-400 tracking-wider.
- RIGHT: `<nav>` DM Mono 13px links — `Dashboard` (teal-300, pulsing teal dot, →/app/), `Docs`, `Integrations`, `Agents`, `Deployment` (neutral-300, hover→white).

## Landing Footer (inline, lines ~1504-1536)

`border-t-2 border-neutral-800 bg-black pt-16 pb-12`, `max-w-7xl`:
- 2-col grid: left = pet-logo + `SHIBA` heading + DM Mono tagline blurb; right = 2-col nav grid (Dashboard teal-300, Docs/Integrations/Agents/Deployment neutral-400).
- Bottom bar: `border-t` — `© 2026 Shiba. All rights reserved. Self-hosted on Cloudflare Workers + Sandbox.` left; right = emerald dot + `Open source · Self-hosted`.

## Dashboard shell (React, `/app/` — separate surface)
`src/dashboard/` — sidebar nav (WORKSPACE: Tasks/Runs/Missions/Automations; SANDBOX: VM/Agents/Gates/Architecture; SYSTEM cluster), navy `#0000a8` active pill, header breadcrumb `AI Intern / <label>`, ⌘K cmdk menu, next-themes dark toggle. NOT part of landing redesign.
