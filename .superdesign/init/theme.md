# Theme — ai-intern (tryshiba.dev landing)

## Part 1 — Compact token summary (use this first)

### Color palette (landing, dark-only)
- `--color-black: #000000` — page bg
- `--color-white: #ffffff` — heading text
- `--color-teal-200: #abe4de` / `-300: #63c8c1` / `-400: #4db4b0` / `-500: #339997` / `-600: #267b7a`
- `--color-primary: var(--color-teal-300)` `#63c8c1` — primary accent (buttons, highlights)
- `--color-primary-dark: var(--color-teal-600)` `#267b7a` — button border/shadow
- `--color-grass-green-400: #96c95f`, `--color-yuzu-yellow-400: #ebc04b` (manga SFX), `--color-orange-red: #ff4512` (diff-del), `--color-pelican-orange-500: #ef722a`, `--color-galaxy-purple-500: #ae69b1`
- `--color-header-height: 4.25rem`

Surface/card colors (literal, used throughout):
- Panel bg `#090a0d`, panel border `#22262e`, hover `#404856`
- Secondary btn bg `#111317`, border `#333842`
- IDE titlebar `#12141a`, tab bar `#0b0d11`, console body `#07080b`, card-in-panel `#101217`, chip `#101218`
- Neutral text: `neutral-300/400/500` body, `neutral-800` borders
- Status: teal `#63c8c1`, cyan `#0891b2`/cyan-300, emerald-400, purple `#7c3aed`/purple-300, amber-400
- Body text `#f3f4f6`

### Typography
- Display/headings: `'Bebas Neue', Impact, sans-serif` (`.font-heading`/`.font-display`) — uppercase, `letter-spacing:0.03em`, `tracking-tight`, huge sizes (hero `text-6xl`→`[7.5rem]`, section `text-5xl/6xl`, card `text-3xl`)
- Manga SFX: `'Bangers', 'Comic Sans MS', cursive` (`.font-manga`/`.font-comic`) — `letter-spacing:0.05em`, colored (yuzu-yellow, teal, emerald)
- Tech/mono: `'DM Mono','Geist Mono',monospace` (`.font-dm-mono`/`.font-tech`) — nav, labels, body-small, code, badges (`text-[10px]`–`text-sm`)
- Body: `'Inter', system-ui, sans-serif` — page base

### Signature styles
- Neo-brutalist offset shadow: `box-shadow: -3px 3px 0 0 <dark>` collapses to `0` on hover with `translate(2px,-2px)`
- Panel: `2px solid #22262e` + `#090a0d` bg + `rounded-xl`
- Buttons: `rounded-lg`, 1.5px border, uppercase Bebas for primary
- Badges/chips: `px-2 py-0.5 rounded text-[10px] font-dm-mono font-bold uppercase bg-<color>/20 text-<color>-300 border border-<color>/40`
- Mascot badges: circular `border-2 border-black`, colored bg, `<img>` sticker, tiny emoji badge bottom-right
- Grid bg: 32px white-4% gridlines on black
- Diff: add = teal tint/left-bar, del = orange-red tint/left-bar

### Spacing / layout
- Containers: `max-w-7xl` (header/footer/sections), `max-w-6xl` (hero), `max-w-5xl` (IDE window), `max-w-2xl` (subtitle)
- Section padding `py-20 sm:py-28`, hero `pt-6 sm:pt-10 pb-16`, marquee `py-10`
- Card padding `p-6`, grids `gap-6` (use-cases `md:2 lg:3` cols), `gap-4` CTAs
- Radius: `rounded-lg` (btns/inner), `rounded-xl` (panels), `rounded-full` (avatars/dots)

### Motion
- `transition-all 0.15s ease-out` (buttons), `0.2s` (panels), `0.3s` (mascot rotate)
- Marquee 30s linear infinite; mascot float 3.5s / bounce 2.2s / breathe 2.8s / sway 3s; eye-blink 3.8s
- Reveal: IntersectionObserver staggered `.is-visible` (75ms)
- `prefers-reduced-motion: reduce` → all animations/transitions off
- Focus: `outline: 2px solid #63c8c1; outline-offset: 4px`

## Part 2 — Raw source

### tailwind.config.js (`web/`)
```js
export default {
  content: ["./src/**/*.{js,ts,jsx,tsx,html,astro,md,mdx}"],
  theme: { extend: {
    fontFamily: {
      display: ['"Bebas Neue"','Impact','sans-serif'],
      comic: ['Bangers','"Comic Sans MS"','cursive','sans-serif'],
      tech: ['"DM Mono"','"Geist Mono"','monospace'],
      sans: ['Inter','system-ui','sans-serif'],
    },
    colors: { brand: { DEFAULT:'#0B9F95', light:'#2dd4bf', dark:'#097d75', glow:'rgba(11,159,149,0.25)' } }
  }},
  plugins: [],
}
```

### Landing `:root` tokens (inline `<style is:global>` in index.astro)
```css
:root {
  --color-black:#000000; --color-white:#ffffff;
  --color-teal-200:#abe4de; --color-teal-300:#63c8c1; --color-teal-400:#4db4b0;
  --color-teal-500:#339997; --color-teal-600:#267b7a;
  --color-primary:var(--color-teal-300); --color-primary-dark:var(--color-teal-600);
  --color-grass-green-400:#96c95f; --color-yuzu-yellow-400:#ebc04b;
  --color-orange-red:#ff4512; --color-pelican-orange-500:#ef722a;
  --color-galaxy-purple-500:#ae69b1; --color-header-height:4.25rem;
}
body { background-color:#000 !important; color:#f3f4f6 !important;
  font-family:'Inter',system-ui,sans-serif; overflow-x:hidden; }
```

### Docs theme (`web/src/styles/theme.css`, Starlight)
Brand teal `#0B9F95`/`#2dd4bf`, dark charcoal `#09090b`/`#0f172a` surfaces, Space Grotesk display + Inter body + DM Mono. Card `rgba(18,24,32,.7)` bg, `rgba(255,255,255,.08)` border, teal glow shadow. (Separate surface from landing; shares teal accent.)

### design.md (repo-locked system)
Genre: modern-minimal dev-tool/infra. Accent teal `#0B9F95` ≈ `oklch(60% 0.11 185)`. Display Space Grotesk 500-700, body Inter 400-600, mono DM Mono. 8pt spacing. NOTE: landing page diverges into neo-brutalist manga (Bebas/Bangers) — the manga system in Part 1 is authoritative for `/`.
