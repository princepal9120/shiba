# Extractable components — ai-intern landing

The landing page is a single self-contained `.astro` file (no component imports). The candidates below are inline sections that recur and could become reusable Superdesign `DraftComponent`s. None are required — the page reproduces fine without extraction — but these are the highest-value extractions if component reuse across sibling pages is wanted.

## NavHeader
- Source: `web/src/pages/index.astro` (header block ~lines 285-314)
- Category: layout
- Description: Sticky top nav — pet-logo circle + SHIBA wordmark + DM Mono link row
- Extractable props: `activeItem` (string, default: "home")
- Hardcoded: logo img, link labels/hrefs, brick overlay, all CSS

## SiteFooter
- Source: `index.astro` (~lines 1504-1536)
- Category: layout
- Description: Footer — logo + tagline + 2-col nav + copyright bar
- Extractable props: none meaningful
- Hardcoded: logo, links, copyright line

## MangaPanel (card)
- Source: `.manga-panel` usage across use-cases/integrations (~lines 590-830, 982-1160)
- Category: basic
- Description: 2px-border dark comic panel; header badge + SFX label + Bebas title + DM Mono body + illustration/mascot area
- Extractable props: `accentColor` (teal/emerald/purple/cyan/amber), `sfxLabel`, `title`
- Hardcoded: border/bg/hover CSS, badge style, mascot sticker slot

## MangaButton
- Source: `.manga-btn-primary` / `.manga-btn-secondary` (~lines 105-132, used throughout)
- Category: basic
- Description: Neo-brutalist offset-shadow button (primary teal / secondary dark)
- Extractable props: `label`, `href`, `variant` (primary|secondary)
- Hardcoded: shadow/border/hover-translate CSS

## SectionHeader
- Source: repeated pattern (~lines 568-585 etc.)
- Category: basic
- Description: icon img + Bebas uppercase H2 + DM Mono sub + optional right CTA button
- Extractable props: `title`, `subtitle`, `ctaLabel`, `ctaHref`
- Hardcoded: type scale, spacing, border-b

## IntegrationCard / UseCaseCard
- Source: integrations grid (~982-1160), use-cases grid (~590-830)
- Category: basic
- Description: manga-panel with brand icon header + manga UI mockup body
- Extractable props: `brandName`, `accentColor`
- Hardcoded: mockup illustration markup

Note: extraction is optional here. For a single landing redesign, inline HTML in the draft is simpler and the skill recommends skipping basic primitives.
