# Manga-Tech & Capybara-Shiba Theme Blueprint
Reverse-engineered from `/Users/princepal/oss/shiba-ai-coworker/web/public/assets/theme`.

This document records the exact visual DNA, design rules, color formulas, inking parameters, and asset taxonomy of the hybrid Manga / Neo-Brutalist Developer Tool aesthetic.

---

## 1. Visual Taxonomy & Asset Inventory

The 28 assets in the theme directory fall into four distinct functional tiers:

### Tier 1: Environmental & Background Manga Panels
- **`manga-bg.webp`** (2288 × 1332 px, RGBA):
  - *Subject*: Traditional Japanese rock garden and onsen stream with waterfall and bonsai/pine foliage.
  - *Technique*: High-contrast black ink pen work, 60L-80L screentone shading, water reflection hatching, and a dramatic black 45° diagonal comic panel border slice.
  - *Usage*: Hero backdrops, section division diagonal dividers.
- **`pricing-section-building.webp`** (2392 × 1015 px, RGBA):
  - *Subject*: Panoramic Tokyo commercial skyline with skyscrapers, communication towers, and office window grids.
  - *Technique*: Pure architectural pen-and-ink with screentone gradient fills. Clean transparent sky for baseline page anchoring.
  - *Usage*: Section footers, pricing table baselines, architecture diagrams.

### Tier 2: Mascot Character Art (Capybara, Shiba, Pelican)
- **`fast-flexible-vms.9f5f57cd.webp`** (926 × 996 px, RGBA):
  - *Subject*: Capybara embracing a server/parcel box with pink heart eyes, surrounded by towering server microVM stacks and small yuzu fruit companions.
- **`hanging-mascot.c668b802.webp`** (765 × 1129 px, RGBA):
  - *Subject*: Capybara wearing an orange construction safety helmet, dangling from a hand-inked rope, with a mini orange assistant cheering from above.
- **`mascot-riding.1d51ba0e.webp`** (1260 × 818 px, RGBA):
  - *Subject*: Capybara riding on the back of a soaring white pelican with a large warm apricot beak and squinting joyful eyes.
- **`mascot-with-key.39df22c3.webp`** (1000 × 620 px, RGBA):
  - *Subject*: Capybara riding a stylized flying cloud (Kinto'un / Sun Wukong style) over snowcapped mountain ridges while holding a bronze triple-ring key staff.
- **`mascot-struggling-to-climb.9288d165.webp`** (781 × 925 px, RGBA):
  - *Subject*: Capybara in hardhat struggling uphill with comic tear drops and action burst spikes.
- **`mascot-sleeping.webp`** (269 × 119 px, RGBA):
  - *Subject*: Flat-laying peaceful sleeping capybara sticker for compact UI corners and empty states.
- **`circle_shiba.svg`** (250 × 250 px, SVG):
  - *Subject*: Golden Shiba Inu avatar wearing cyan retro shades in a bold circular ink frame.
- **`scared-cat.6539a00e.png`** (41 × 41 px, RGBA):
  - *Subject*: Micro black cat mascot with startled circular eyes for micro-interactions and error warnings.

### Tier 3: Circular Comic Badges & Feature Icons
- **`soc-2-illustration.webp`** (778 × 966 px, RGBA):
  - *Subject*: Hanging silver medal with bold hand-drawn "AICPA SOC 2" lettering, laurel leaves, cobalt blue ribbon (`#3B82F6`), and gold buckle.
- **`lightbulb.529c5ef0.webp`** (501 × 501 px, RGBA):
  - *Subject*: Bulb with warm yuzu orange glow (`#FE9E5D`), cloud filament, olive brass base, and circular ink frame.
- **`puzzle.524a3791.webp`** (282 × 282 px, RGBA):
  - *Subject*: Periwinkle blue (`#9AB7FF`) floating puzzle piece with white cloud shadows.
- **`circle_card.svg`** & **`circle_briefcase.svg`**:
  - *Subject*: Minimalist financial card and business briefcase encapsulated in 250px circular ink emblems.

### Tier 4: UI Patterns & Vector Badges
- **`sidebar-bg-tile.svg`** & **`sidebar-bg-tile-brick.svg`**:
  - *Technique*: 45° sheared repeating brick tiles providing subtle manga screentone texture to headers and sidebars.
- Partner integration badges: **`runpod.svg`**, **`exa.svg`**, **`supermemory.svg`**, **`million.svg`**, **`goblins.svg`**, **`autumn.svg`**, **`loop.svg`**.

---

## 2. Inking & Stroke Dynamics

1. **Contour Lines**: Solid black (`#000000` / `#0b0b0b`) outer strokes ranging from **2.5px to 3.5px** with smooth vector curves.
2. **Inner Detail Lines**: Thinner ink lines (**1.0px to 1.5px**) for facial features, paw separators, and mechanical panel lines.
3. **Shadow Hatching (Kage-sen)**:
   - Groups of 3 to 7 parallel 45° diagonal ink lines at joints, under chins, along rope edges, and beneath wings.
   - Line length is tapered to follow body curvature.
4. **Comic Accents**:
   - Shock sparks: 3-point star bursts.
   - Sweat/Tears: Teardrop shapes with a white specular highlight dot.
   - Action lines: Radiating or directional speed streaks.

---

## 3. Color Architecture & Tokens

| Token Role | Hex Code | Visual Application |
|---|---|---|
| **Canvas Background** | `#000000` / `#090a0d` | Pure black page base and dark card panels |
| **Panel Border** | `#22262e` | High-contrast structural comic borders |
| **Panel Hover** | `#404856` | Interactive border brightening |
| **Manga Screentone White** | `#FFFFFF` / `#F4F2F2` | White paper fills, clouds, dialogue bubbles |
| **Primary Brand Teal** | `#63c8c1` | CTA buttons, active tabs, glowing badges |
| **Dark Border Teal** | `#267b7a` | Hard-edge neo-brutalist button drop shadows |
| **Capybara Fur Base** | `#af5f51` | Main body of the capybara mascot |
| **Capybara Fur Shadow** | `#9a4f44` | Underbelly and limb occlusion shading |
| **Yuzu / Construction Orange** | `#fe9e5d` / `#ef722a` | Hardhats, yuzu fruit, pelican beaks |
| **Yuzu Yellow Accent** | `#ebc04b` / `#facc15` | Sparkles, stars, warning badges |
| **Periwinkle Blue Accent** | `#9ab7ff` / `#4f9cf0` | Feature puzzle pieces, clouds, sky tints |
| **Shiba Coat Gold** | `#e89b3d` / `#d97706` | Shiba mascot ears and coat |
| **Sunglasses Cyan** | `#06b6d4` | Shiba cool sunglasses lens fill |

---

## 4. Compositional Rules for Future Assets

When generating or drafting new assets to fit this theme:
1. **Always use transparent PNG or WebP** for characters and badges so they float seamlessly over dark `#090a0d` UI panels.
2. **Avoid realistic photorealism, 3D clay, or plastic rendering.** The aesthetic is strictly 2D illustrative manga line art with flat or two-tone cel fills.
3. **Keep character anatomy simplified:** Big rounded head, soft rectangular body, small rounded extremities, dot eyes with expressive eyebrows.
4. **Anchor large environmental art to borders:** Sky should fade to transparent or solid white; ground should have a solid ink baseline.
5. **Use 3px offset neo-brutalist shadows:** Any interactive or standalone UI element using these assets pairs with a `-3px 3px 0 0 #000000` or `-3px 3px 0 0 var(--color-primary-dark)` hard shadow.

