# Routes — ai-intern

## Marketing / landing (Astro static, `web/`)
| Route | File | Notes |
|---|---|---|
| `/` | `web/src/pages/index.astro` | **tryshiba.dev landing — THE REDESIGN TARGET.** Self-contained, ~1697 lines. |
| `/llms.txt` | `web/src/pages/llms.txt.ts` | LLM text endpoint |
| `/sitemap.xml` | `web/src/pages/sitemap.xml.ts` | sitemap |
| `/docs/*` | Starlight (`web/src/content/docs/*.mdx`) | Docs site, own Starlight layout |
| `/docs` | redirect → `/docs/overview/` | astro.config redirects |

## Dashboard app (React SPA, `src/dashboard/` → built to `public/app/`)
| Route | Notes |
|---|---|
| `/app/` | SPA root. Views: Tasks, Runs, Missions, Automations, VM, Agents, Gates, Architecture. Sidebar + workspace panel. |

## Worker API (`src/`, Cloudflare Worker)
`/api/*` — runs, approvals, agents, memory, mail, audit. Backend only.

## Repo root
`index.html` at repo root meta-refreshes to `/app/` (dashboard entry when served statically).
