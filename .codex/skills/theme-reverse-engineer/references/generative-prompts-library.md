# Generative Prompts Library: Manga-Tech & Mascot Theme

Exact, field-tested prompts for recreating or expanding the aesthetic found in `/Users/princepal/oss/shiba-ai-coworker/web/public/assets/theme`.

---

## 1. Mascot Prompts (Capybara, Shiba, Pelican, Helpers)

### A. Capybara Debugging in MicroVM / Terminal
- **Midjourney v6**:
  ```text
  A cute capybara mascot wearing large retro over-ear headphones, sitting cross-legged and typing on a glowing green terminal computer screen, authentic Japanese manga line art, bold black G-pen ink contour outlines, clean flat cel color shading with warm chestnut brown (#af5f51) body and bright teal (#63c8c1) highlights, subtle diagonal pen hatching for shadow, cute dot eyes, transparent background, isolated 2D commercial mascot sticker --no photorealistic, 3d, realistic, gradient, blurry --style raw --v 6.0 --s 200
  ```
- **FLUX.1 (Dev/Schnell)**:
  ```text
  2D commercial character design of a cute capybara wearing bulky retro headphones typing on an old-school CRT computer monitor with code on screen. Japanese manga line art style, heavy black ink outlines, flat cel shading in terracotta brown and neon cyan, hand-drawn diagonal ink hatching in corners, pure solid white background, high contrast, clean vector aesthetic.
  ```
- **DALL-E 3**:
  ```text
  A clean 2D Japanese comic style illustration of a charming capybara software engineer with headphones typing on a retro computer. Thick bold black ink contours, classic manga screentone hatching, flat warm brown fur coloring with neon cyan screen reflection, isolated on a pure white background.
  ```

### B. Capybara Flying on Kinto'un Cloud with Magic Staff / Key
- **Midjourney v6**:
  ```text
  A happy capybara character surfing through the sky atop a fluffy white stylized manga cumulus cloud, holding a vintage golden key staff with three interlocking rings, snow-covered stylized mountain peaks in the distant background, Japanese shonen manga line art, bold black ink contour lines, hand-drawn diagonal ink hatching, flat cel colors in warm brown (#af5f51) and gold, transparent background, high contrast 2D comic art --v 6.0 --style raw --s 180
  ```
- **FLUX.1**:
  ```text
  Manga illustration of a friendly capybara riding a flying white cloud over mountain ridges, holding a tall bronze key staff. Bold black pen strokes, Japanese comic book screentone shading, flat cel colors, minimalist facial features with peaceful smile, isolated on white background.
  ```

### C. Capybara and White Pelican Soaring
- **Midjourney v6**:
  ```text
  A cute warm brown capybara happily riding on the back of a large white pelican flying with outstretched wings, large orange pelican beak, Japanese manga illustration, clean bold black ink lines with varying weight, parallel cross-hatching under wings, flat warm orange and chestnut cel fills, transparent background, iconic 2D tech mascot --style raw --v 6.0
  ```

### D. Capybara in Construction Hardhat Scaling a Wall / Cable
- **Midjourney v6**:
  ```text
  A determined capybara wearing a bright orange construction safety helmet, climbing up a thick braided black rope, manga sweat drops and comic action bursts, small cheerful yuzu orange mascot watching from above, bold hand-drawn ink contours, diagonal shadow hatching, flat cel colors, isolated on solid white --style raw --v 6.0
  ```

### E. Sleeping Mascot Empty State / Compact Sticker
- **Midjourney v6**:
  ```text
  A peaceful capybara sleeping flat on its belly with closed eyes and a small zzz comic symbol, Japanese kawaii manga line art, thick black brush outlines, flat warm brown tone (#af5f51), minimal cute sticker art, transparent background --style raw --v 6.0
  ```

---

## 2. Manga Architectural & Landscape Backgrounds

### A. Japanese Zen Garden & Waterfall (Manga Panel Cutaway)
- **Midjourney v6**:
  ```text
  A widescreen Japanese seinen manga illustration of a tranquil zen landscape with natural boulders, a cascading mountain waterfall, pine trees, and a clear reflecting pool. Intricate pen-and-ink drawing, 60L screentone halftone dot textures, high-contrast monochrome black and white ink, dynamic 45-degree diagonal manga panel border frame cutting through the composition, clean negative space --ar 16:9 --style raw --v 6.0 --s 250
  ```
- **FLUX.1**:
  ```text
  Authentic black and white Japanese manga panel background of a rocky riverbed with a waterfall and bonsai trees. Fine architectural ink line work, screentone dot shading, sharp diagonal black panel borders, pristine white paper negative space, high contrast graphic novel art.
  ```

### B. Tokyo Skyscraper Cityline (Architectural Halftone Baseline)
- **Midjourney v6**:
  ```text
  A panoramic wide illustration of modern Tokyo skyscraper buildings and financial district towers, drawn in traditional Japanese manga architectural pen and ink style, detailed window mullions, roof antennas, 70L screentone halftone shading on glass surfaces, pure black and white line art, flat transparent sky above the skyline for website footer grounding --ar 21:9 --style raw --v 6.0
  ```
- **FLUX.1**:
  ```text
  Ultra-wide architectural line drawing of modern skyscrapers and office towers. Japanese comic book halftone screentone gradients, sharp ink linework, transparent clean sky background, monochrome black and white, perfect for website section baseline.
  ```

---

## 3. Circular Comic Badges & Feature Emblems

### A. Security Medallion (SOC 2 / Shield)
- **Midjourney v6**:
  ```text
  A circular illustrated medal emblem hanging from a royal blue ribbon with gold buckle, bold black hand-inked letters reading 'SECURITY APPROVED' inside, laurel branch leaf wreath, silver circular medallion with ink shadow hatching, Japanese comic badge style, isolated on transparent background --style raw --v 6.0
  ```

### B. Comic Lightbulb / Idea Feature Badge
- **Midjourney v6**:
  ```text
  A circular comic book feature badge containing an incandescent lightbulb with a fluffy white cloud filament and glowing warm yuzu orange glass (#fe9e5d), olive-green brass screw base, bold round black ink border with reflection highlight slice, retro manga sticker --style raw --v 6.0
  ```

### C. Floating Puzzle Piece Integration Badge
- **Midjourney v6**:
  ```text
  A circular Japanese manga icon badge of a periwinkle blue (#9ab7ff) jigsaw puzzle piece floating amid stylized white manga clouds, bold round black ink border, clean 2D vector style with hand-drawn shadow hatching, transparent background --style raw --v 6.0
  ```

---

## 4. Negative Prompting & Parameter Standards

For all image generation engines, enforce the following negative constraints to prevent AI artifacts:
- **Midjourney Negative Token**:
  `--no photorealistic, 3d render, claymation, plastic, blurry, gradients, airbrushed, digital painting noise, dropshadow, realistic hair fur texture`
- **Aspect Ratios**:
  - Mascot singles: `--ar 1:1` or `--ar 4:5`
  - Manga landscapes: `--ar 16:9`
  - Architectural baselines: `--ar 21:9` or `--ar 3:1`
  - Circular badges: `--ar 1:1`

