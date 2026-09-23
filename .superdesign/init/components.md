# Components — ai-intern

The landing page is self-contained Astro (no reusable React component imports). Shared primitives are CSS classes defined in the inline `<style is:global>` block of `web/src/pages/index.astro` and `web/src/styles/theme.css`.

## CSS-class primitives (defined inline in index.astro)

### `.manga-panel`
Comic-panel card container. `border: 2px solid #22262e; background: #090a0d; border-radius via class (rounded-xl); transition border-color/transform; hover border → #404856`. Used for every content card (use cases, integrations, benchmark, hero IDE window).

### `.manga-btn-primary`
Primary CTA. `background: var(--color-teal-300) #63c8c1; color: #000; font-weight:700; border:1.5px solid var(--color-primary-dark) #267b7a; box-shadow:-3px 3px 0 0 var(--color-primary-dark); transition all .15s`. Hover: `translate(2px,-2px)`, shadow collapses to `0 0 0 0`, bg lightens `#72d6cf`. Renders with `font-heading` (Bebas) uppercase inside.

### `.manga-btn-secondary`
Secondary CTA. `background:#111317; color:#fff; font-weight:600; border:1.5px solid #333842; box-shadow:-3px 3px 0 0 #000`. Hover: `translate(2px,-2px)`, shadow collapses, border → teal-400, text → teal-300.

### `.grid-bg`
Page background grid. `background-size:32px 32px; linear-gradient 1px lines rgba(255,255,255,0.04)` both axes. Applied to `<body>`.

### `.manga-brick-bg` / `.manga-tile-bg`
Decorative SVG pattern overlays (`/assets/theme/sidebar-bg-tile-brick.svg`, `sidebar-bg-tile.svg`), `background-size:2.4rem`, repeat. Used as low-opacity `::after` fills (e.g. header).

### `.diff-line-add` / `.diff-line-del`
Code-diff lines. add: `bg rgba(99,200,193,.15); color #63c8c1; border-left 2px #4db4b0`. del: `bg rgba(255,69,18,.15); color #ff6842; border-left 2px #ff4512`.

### Mascot animations
`.mascot-floating` (translateY ±8px + rotate ±2deg, 3.5s), `.mascot-bouncing` (2.2s), `.mascot-breathing` (scale 1→1.05, 2.8s), `.mascot-swaying` (rotate ±4deg, 3s). Applied to shiba sticker `<img>`s.

### `.manga-marquee`
Infinite horizontal scroll. `display:flex; width:max-content; animation: mangaMarquee 30s linear infinite` (translateX 0→-50%). Pauses on hover. Duplicate content for seamless loop.

### Blinking-eye frames
`#shiba-frame-1/2/3` + `.shiba-frame-*` classes — `animShadesGlobal`/`animSquintGlobal`/`animWinkGlobal` keyframes (3.8s cycle) toggling opacity for blink/squint/wink on the animated SVG mascot.

### `.agent-tab`
Hero role-switcher tabs. `flex-shrink:0; white-space:nowrap; min-height:44px`. Active state: `bg-teal-400/20 text-teal-300 border-teal-400/40 font-bold`.

### `.usecase-panel`
Scroll-reveal card (starts hidden, `.is-visible` added by IntersectionObserver with 75ms stagger).

## React component (dashboard surface, not landing)
`web/src/components/TaskForm.tsx` — task composer form (repo URL, branch, harness select, Create PR checkbox). Used in `/app/` dashboard, not on the landing page.

## Fonts loaded (Google Fonts)
`Inter` 400-900, `Bebas Neue`, `Bangers`, `DM Mono` 400/500, `Geist Mono` 400-600.
