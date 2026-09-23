# Init — ai-intern (tryshiba.dev)

Framework: Astro 4 (static, `output: 'static'`) + Starlight docs + Tailwind CSS.
Meta-framework: Astro. Component library: custom (no shadcn/MUI). CSS: Tailwind + hand-rolled CSS vars.

## Layout
- Marketing landing: `web/src/pages/index.astro` (route `/`, tryshiba.dev). Self-contained single file: inline `<style is:global>` + `<script>` for interactions. No shared layout component.
- Docs: Starlight (`web/`), sidebar nav, custom `web/src/styles/theme.css`.
- Dashboard app: React 19 SPA at `/app/` (`src/dashboard/`, vite build → `public/app`). Separate surface from landing.

## The landing page (`/` = tryshiba.dev)
Single-file Astro page, ~1697 lines. Inline global style block defines the whole "neo-brutalist manga" system. Sections in order:
1. Sticky header — logo (pet-logo.png) + "SHIBA / THE BEST AI SOFTWARE ENGINEER" + nav (Dashboard, Docs, Integrations, Agents, Deployment)
2. Hero — giant Bebas Neue headline "THE BEST SELF-HOSTED / AI SOFTWARE ENGINEER", DM Mono subtitle, 3 CTAs, then an interactive multi-agent IDE window (manga-panel) with role tabs (Pipeline/Captain/Build/Review/Terminal), agent cards with shiba sticker avatars, diff lines, terminal footer
3. Marquee — "BUILT ON MODERN OPEN SOURCE & CLOUDFLARE RUNTIMES" infinite scroll of tech chips
4. Use Cases — 6 manga-panel cards (E2E Testing, Bug Triage, Code Review & QA, Migration, BYOK, Automations), each with shiba mascot sticker + SFX label
5. Features & Benchmark — benchmark card w/ comparison bars (Vitest 397/397, spinup latency, TS/lint) + 3 pillar cards
6. Integrations — comic strip w/ shiba-riding mascot + 4 cards (Slack, GitHub, Cloudflare Sandbox, REST/CLI API) with real brand icons
7. Harness Runtime Architecture — diagram + security callout
8. Enterprise & Security
9. Self-Hosting & Open Source — cost transparency cards
10. From the Blog
11. Bottom manga CTA — speech headline + circular shiba badge artwork
12. Footer — logo + nav + © 2026

## Design language: "Neo-Brutalist Manga"
- Black bg `#000`, white text, teal accent `#63c8c1`/`#0B9F95`
- `manga-panel`: 2px solid `#22262e` border, `#090a0d` bg, rounded-xl
- `manga-btn-primary`: teal bg, black text, 1.5px dark border, hard offset shadow `-3px 3px 0` that collapses on hover (translate 2,-2)
- `manga-btn-secondary`: `#111317` bg, white text, `#333842` border, black offset shadow
- Fonts: Bebas Neue (display/headings, uppercase, tracking), Bangers (manga SFX), DM Mono/Geist Mono (tech labels/body-small), Inter (body)
- Mascot: shiba inu stickers (`web/public/assets/mascot/*.webp`, `pet-logo.png`), animated blinking-eye SVG frames
- Decorative: grid-bg, brick/tile SVG pattern overlays, diff-line add/del colors, mascot float/bounce/breathe/sway keyframes
- Motion: hover lifts, staggered IntersectionObserver reveals, live "simulation" tickers, marquee
