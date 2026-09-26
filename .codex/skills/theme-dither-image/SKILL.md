---
name: theme-dither-image
description: Generate AI hero/illustration images and quantize them to the site's theme palette via Bayer ordered dithering (zuse.sh / bezalel.network style). Use when creating blog heroes, marketing illustrations, retro pixel-art assets, or theme-matched light/dark image variants for the Shiba site.
---

# Theme-Dithered Images

Pipeline: built-in image_gen tool -> scripts/zuse-dither.py -> light + dark palette variants -> CSS data-theme swap.

## Generate

Use the built-in image_gen tool. Style prompts that work:

- Glass console (blog/marketing): "Minimalist isometric 3D render of a futuristic glass terminal console hovering in a pitch-black void, sleek holographic panels, sharp geometric lines, techno-brutalist developer tool aesthetic, single light source, high contrast shadows, clean silhouette, zero clutter, cinematic dark mode, wide 16:9 composition"
- Retro window (bezalel-style): "Retro 90s desktop OS window, navy titlebar with minimize/maximize/close buttons, grey menu bar, pixel-art CRT monitors, outlined tool chips, icon row with labels, bottom status bar, flat pixel aesthetic, wide 16:9"
- Mascot cards: "A cute shiba inu dog mascot <action>, flat vector illustration, solid dark navy background with sparkle stars, bold outlines, clean minimal shapes, wide 16:9 composition"

Generated files land under ~/.codex/generated_images/<id>/exec-*.png — copy the newest one out before dithering.

## Dither

    python3 scripts/zuse-dither.py <in.png> <out.png> [pixel_size] [palette]

Palettes (defined in scripts/zuse-dither.py):
- violet-dusk — zuse.sh blog palette (blog heroes)
- shiba-light — theme.css light tokens (site illustrations)
- shiba-dark — theme.css dark tokens

Site images: emit BOTH shiba-light and shiba-dark variants (<name>.png and <name>-dark.png).

## Light/dark swap (site, not blog)

Theme is data-theme on <html>, not prefers-color-scheme:

    <img class="dithered-light" src="/assets/x.png" alt="..." />
    <img class="dithered-dark" src="/assets/x-dark.png" alt="" aria-hidden="true" />

    .dithered-dark { display:none; }
    :root[data-theme='dark'] .dithered-dark { display:block; }
    :root[data-theme='dark'] .dithered-light { visibility:hidden; }

Inside an aspect-ratio slot (.step-illustration), give the dark img position:absolute; inset:0.

## Animated variant

Shift the Bayer matrix per frame (np.roll) and re-dither — 4 frames, 240ms, looping GIF = retro CRT shimmer, still palette-quantized.

## Conventions

- Blog heroes: apps/web/public/blog/<slug>.png, embed ![alt](/blog/<slug>.png) after frontmatter.
- Site assets: apps/web/public/assets/.
- image-rendering: pixelated on all dithered img CSS.
- Dithered output is ~20-60KB vs ~1MB raw — always dither before commit.
