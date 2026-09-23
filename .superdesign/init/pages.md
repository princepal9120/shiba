# Pages — dependency trees

## `/` (tryshiba.dev landing) — REDESIGN TARGET
Entry: `web/src/pages/index.astro` (~1697 lines, self-contained)

Dependencies (all local):
- `web/src/styles/tailwind.css` — `@tailwind base/components/utilities` only
- `web/src/styles/theme.css` — Starlight/docs theme (loaded but mostly docs-scoped; landing uses its own inline `:root`)
- Inline `<style is:global>` (lines ~43-281) — the entire manga design system
- Inline `<script>` (lines ~1539-1697) — eye-blink, approvals, replay, tab switcher, scroll-reveal, live simulations

Static assets referenced (all under `web/public/`):
- `/assets/mascot/pet-logo.png` — logo (header + footer)
- `/assets/mascot/shiba-sticker-{sunglasses,climbing,hero,riding,sleeping}.webp` — mascot stickers
- `/assets/mascot/shiba-logo-animated.svg`, `doge-avatar.jpg`, `pet-mascot.js`
- `/assets/theme/circle_shiba.svg`, `lightbulb.529c5ef0.webp`, `sidebar-bg-tile.svg`, `sidebar-bg-tile-brick.svg`, `scared-cat.6539a00e.png`
- `/assets/synara/hero-bg.jpg` — hero background photo
- Google Fonts: Inter, Bebas Neue, Bangers, DM Mono, Geist Mono

No component imports — the page is one big Astro file. There is no layout wrapper.

## `/app/` (dashboard SPA) — separate surface
Entry: `src/dashboard/` React app (vite). Components: VMInspector, OnboardingModal, StepTimeline, TaskForm, etc. Not part of landing redesign.

## `/docs/*` (Starlight)
`web/src/content/docs/*.mdx`, Starlight layout + `theme.css`. Not part of landing redesign.
