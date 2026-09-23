# Design System — Shiba / tryshiba.dev

## Product
Shiba (AI Intern) — open-source, self-hosted AI software engineer. Approval-gated coding tasks delegated to parallel agents running in isolated Cloudflare Sandbox containers. Task → plan → build → verified PR. Audience: senior devs / eng teams who want Claude-Code-class automation on their own infra, BYOK, full transparency.

## Voice / positioning
Confident, technical, playful. "The best AI software engineer" but self-hosted + OSS + honest about cost. Manga/shiba-inu mascot personality. Dev-tool credibility over SaaS polish.

## Visual language — Neo-Brutalist Manga (current)
- Pure black `#000` page, white headings, teal `#63c8c1`/`#0B9F95` accent
- Bebas Neue display (huge uppercase), Bangers for SFX, DM Mono for tech labels, Inter body
- `manga-panel` cards: 2px `#22262e` border, `#090a0d` bg, rounded-xl
- Neo-brutalist buttons: hard offset shadow `-3px 3px 0`, collapses on hover
- Shiba mascot stickers throughout, speech bubbles, "SFX:" labels, diff-line colors
- Grid/pattern backgrounds, marquee chips, staggered reveals, live "simulation" tickers

## Typography scale
- Hero: Bebas `text-6xl`→`7.5rem`, uppercase, `leading-[0.88]`, tracking-tight
- Section H2: Bebas `text-5xl/6xl` uppercase
- Card H3: Bebas `text-3xl` uppercase
- Body/labels: DM Mono `text-[10px]`–`text-base`
- Body copy: Inter `text-xs`–`text-base`, neutral-300/400

## Color tokens
- bg `#000`, panel `#090a0d`, panel-border `#22262e`, hover `#404856`
- surfaces `#111317` `#12141a` `#0b0d11` `#07080b` `#101217` `#101218`
- accent teal `#63c8c1` (primary), `#0B9F95` (brand), `#2dd4bf` (light), `#267b7a` (dark)
- status: emerald-400 (success), cyan `#0891b2` (build), purple `#7c3aed` (review), amber-400 (running), orange-red `#ff4512` (danger/del)
- text: white headings, `#f3f4f6` body, `neutral-300/400/500` muted

## Components
- `.manga-btn-primary`: teal bg, black text, 1.5px dark border, `-3px 3px 0` shadow → hover translate(2,-2) shadow-collapse. Bebas uppercase.
- `.manga-btn-secondary`: `#111317` bg, white, `#333842` border, black offset shadow → hover teal border/text.
- `.manga-panel`: the universal card.
- Badge: `px-2 py-0.5 rounded text-[10px] font-dm-mono font-bold uppercase bg-<c>/20 text-<c>-300 border border-<c>/40`.
- Mascot badge: circular `border-2 border-black`, colored bg, sticker img, emoji corner badge.
- Diff lines: teal-tint add / orange-tint del with left border bar.

## Motion
- Hover lifts + shadow collapse on buttons; border-color on panels
- Marquee 30s infinite; mascot float/bounce/breathe/sway loops; eye-blink 3.8s
- IntersectionObserver staggered card reveals (75ms)
- Live "simulation" text tickers (typing dots, status flips, counters)
- `prefers-reduced-motion` fully supported

## Layout
- `max-w-7xl` shell, `max-w-6xl` hero, `max-w-5xl` hero-artifact, `max-w-2xl` subtitle
- Sections `py-20 sm:py-28`; grids `gap-6`; use-cases `md:2 lg:3` cols
- Sticky header `h-[4.25rem]`, `scroll-margin-top:9rem` on sections

## Assets
- Logo: `/assets/mascot/pet-logo.png` (circular shiba)
- Mascots: `shiba-sticker-{sunglasses,climbing,hero,riding,sleeping}.webp`, `shiba-logo-animated.svg`
- Patterns: `sidebar-bg-tile{,-brick}.svg`, `circle_shiba.svg`, `lightbulb.webp`
- Hero photo bg: `/assets/synara/hero-bg.jpg`
