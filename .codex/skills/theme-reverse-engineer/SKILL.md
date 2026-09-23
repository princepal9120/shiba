---
name: theme-reverse-engineer
description: Reverse engineer any directory of theme assets, UI images, or illustrations into complete design systems, color tokens, Midjourney/FLUX prompts, and SVG/CSS code. Includes pre-loaded specs for the Manga-Tech mascot theme.
metadata:
  short-description: Reverse engineer images and themes into reusable skills, prompts, and design code
---

# Theme Reverse Engineer

Use `$theme-reverse-engineer` to deconstruct any set of visual assets (mascots, illustrations, backgrounds, UI screenshots, or SVG icons) into an actionable, reproducible design blueprint. It transforms raw graphics into:
1. **Visual Style DNA**: Line weight, stroke dynamics, shading techniques (cel, screentone, gradient), and lighting.
2. **Design Tokens & Palette**: Hex color codes, role mappings (canvas, ink, brand accent, mascot tones), and Tailwind/CSS variables.
3. **Generative AI Prompts**: Calibrated prompts for Midjourney v6, FLUX.1, and DALL-E 3 to generate seamless matching assets.
4. **SVG & Code Recipes**: Ready-to-use vector templates, repeating screentone tiles, and neo-brutalist CSS components.

---

## When to Use

- When asked to analyze, reverse-engineer, or recreate an existing visual theme or set of images.
- When generating new mascot actions, feature badges, or backgrounds that must match an existing aesthetic.
- When transforming artwork into CSS/Tailwind design tokens and vector SVG patterns.
- When building new skills or documentation for a specific product's visual identity.

---

## 5-Step Theme Reverse-Engineering Protocol

When given an image directory or visual target:

### 1. Intake & Automated Profiling
Run the built-in analyzer script on the asset directory:
```bash
python3 ~/.codex/skills/theme-reverse-engineer/scripts/theme_analyzer.py /path/to/assets
```
For structured JSON output to pass into agents or pipelines:
```bash
python3 ~/.codex/skills/theme-reverse-engineer/scripts/theme_analyzer.py /path/to/assets --json
```

### 2. Visual Deconstruction
Classify the visual style across four fundamental axes:
- **Inking & Outlines**: Are outlines present? Ink pen weight (e.g., 2.5px-3.5px bold G-pen), corner taper, stroke color (`#000000` vs soft charcoal).
- **Shading Technique**: Flat cel-shading (1-2 tonal bands), 60L-80L manga screentone dots, cross-hatching (kage-sen), or soft gradient airbrush.
- **Character Proportions & Silhouette**: Chibi/kawaii (1:2 head-to-body), stylized mascot, realistic, or geometric abstraction.
- **Negative Space & Grounding**: Transparent cutout vs full-bleed panel, baseline alignment, diagonal comic panel framing.

### 3. Token Extraction & Color Architecture
Extract distinct color roles rather than raw pixel averages:
- `canvas`: Dark background (`#000000`, `#090a0d`) or paper base (`#ffffff`).
- `ink`: Outlines and deep comic shadows (`#0b0b0b`).
- `brand_primary`: High-contrast energetic accent (e.g., Neo-brutalist teal `#63c8c1`).
- `mascot_primary`: Warm organic tone (e.g., Capybara chestnut `#af5f51`, Shiba gold `#e89b3d`).
- `mascot_secondary`: Eye-catching prop color (e.g., Yuzu orange `#fe9e5d`, sunglasses cyan `#06b6d4`).

### 4. Generative Prompt Formulation
Use the prompt builder script to generate engine-specific prompts:
```bash
# Mascot actions
python3 ~/.codex/skills/theme-reverse-engineer/scripts/theme_prompt_builder.py --type mascot --subject "capybara deploying a microVM with a wrench"

# Environmental / manga background
python3 ~/.codex/skills/theme-reverse-engineer/scripts/theme_prompt_builder.py --type background --subject "Tokyo skyscraper skyline at night"

# Circular feature badge
python3 ~/.codex/skills/theme-reverse-engineer/scripts/theme_prompt_builder.py --type badge --subject "glowing CPU chip" --color "#63c8c1"
```

### 5. Vector & UI Component Production
Map the extracted styles into code:
- Convert repeating background patterns into scalable SVG tiles (e.g. 45° sheared halftone bricks).
- Wrap interactive elements in neo-brutalist offset shadows: `box-shadow: -3px 3px 0 0 var(--border-color)`.
- Apply comic panel borders: `border: 2px solid #22262e; background-color: #090a0d`.

---

## Pre-Loaded Theme Reference: Manga-Tech & Capybara-Shiba

This skill includes pre-analyzed documentation for the Manga-Tech developer tool aesthetic found in `shiba-ai-coworker/web/public/assets/theme`:
- [references/manga-tech-theme-blueprint.md](references/manga-tech-theme-blueprint.md): Full breakdown of all 28 assets, stroke rules, and character sheets.
- [references/generative-prompts-library.md](references/generative-prompts-library.md): Ready-to-copy prompts for Midjourney v6, FLUX.1, and DALL-E 3.
- [references/svg-and-css-recipes.md](references/svg-and-css-recipes.md): Copy-pasteable SVG patterns and Tailwind components.

---

## Prompt Formula Cheat Sheet

For generating new assets matching the **Manga-Tech** theme:

```text
A Japanese seinen manga-style illustration of [SUBJECT]. 
Bold black ink line art with hand-drawn hatching, 60L screentone halftone dots, 
clean flat cel-shading with selective color accents (#af5f51 warm brown, #fe9e5d yuzu orange, #63c8c1 teal), 
retro tech anime aesthetic, white or transparent background, high contrast, crisp vector contour lines, 
--no photorealistic, 3d render, hyperdetailed shading, noisy texture, blurry --style raw --v 6.0
```

