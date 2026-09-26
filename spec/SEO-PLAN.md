# Shiba positioning and search plan

**Draft:** 2026-09-26. This is a content and measurement plan, not a claim of search ranking or launch readiness.

## Positioning

**Working category:** an open-source, self-hosted *cloud software engineer* that runs coding tasks in the operator's Cloudflare account. The phrase describes the product direction; do not claim Shiba is literally the first cloud software engineer. Other cloud coding agents and open-source runtimes already exist.

**Why build it:** developers need a task-to-reviewable-change workflow without giving a hosted vendor unchecked repository access. Shiba's distinctive boundary is exact-input human approval before sandbox startup by default (with opt-in unattended mode limited to PR-only automations on an explicit repository allowlist), account-owned Cloudflare infrastructure, provider credentials injected by Worker-side egress (AI Gateway for supported routes, direct forwarding for Devin), and inspectable output. The trust and ownership story is more credible than “fully autonomous engineer” copy.

**Audience:** solo developers and small engineering teams who want to self-host an AI coding agent, delegate scoped GitHub tasks, and review diffs/PRs. Secondary audience: contributors who care about approval gates, Workers, Sandbox, and harness adapters.

**Honest qualifiers:** Shiba is single-tenant; real cloud acceptance still needs the account's AI Gateway credentials and cloud deployment. Do not promise autonomous merging, complete human replacement, a price advantage, or a fully hosted service. A waitlist signup is for project updates and contribution, not access to the open-source code.

## Competitive positioning: Devin Cloud

Shiba's most relevant comparison point is **Devin Cloud** — the hosted, cloud-based software engineer category leader. The framing for any comparison page or positioning copy:

- **Category overlap:** both accept a scoped coding task and return a reviewable change (diff/PR). That shared job-to-be-done is the legitimate basis for comparison.
- **Shiba's actual differentiators** (from this repo, not marketing): open-source and self-hosted in the operator's own Cloudflare account; exact-input human approval before sandbox startup by default, with opt-in unattended mode limited to allowlisted PR-only automations; provider credentials injected by Worker-side egress (AI Gateway for supported routes, direct forwarding for Devin) rather than passed into the sandbox process; inspectable output at every step.
- **Where Devin is stronger:** a managed, hosted product with no self-hosting burden or infrastructure for the operator to run. Do not downplay this — it is the honest trade-off.
- **What not to claim:** no price advantage claim, no “better than Devin” verdict, no claim that self-hosting is right for everyone, and no feature claims about Devin that are not backed by a dated check of Devin's published docs/site.

A dedicated `/compare/` page against Devin Cloud is deferred until (a) Shiba has a **verified cloud deployment** in a real account, and (b) the comparison has been re-sourced against Devin's current published documentation with dates. Until then, `/why-shiba/` may describe the high-level managed-versus-self-hosted trade-off, but must avoid unsupported feature, pricing, or maturity claims.

## Search architecture

| Intent | Page | Main query theme | Next step |
| --- | --- | --- | --- |
| Understand the product | `/` | self-hosted AI software engineer | Read why / docs |
| Founder story and category | `/why-shiba/` | cloud software engineer; why self-host coding agents | Join or inspect architecture |
| Join/contribute | `/waitlist/` | Shiba waitlist; contribute to Shiba | Submit form or open GitHub |
| Evaluate trust | `/docs/approval-gates/`, `/docs/security/` | approval-gated coding agent; AI agent credential isolation | Try local setup |
| Implement | `/docs/getting-started/`, `/docs/deployment/`, `/docs/architecture/` | Cloudflare coding agent; self-host AI coding agent | Deploy in own account |
| Compare alternatives | `/compare/devin-cloud/` — gated on product verification, not a launch date | Devin alternative | Honest comparison + sources |

The comparison should not become a thin SEO doorway page. Publish it only when it has original technical evidence, a dated source review, and useful decision guidance. Do not reuse competitors' branding/assets.

## 90-day execution

1. **Now — make the site crawlable and useful.** Publish `/why-shiba/` and `/waitlist/` with unique titles, descriptions, one H1, self-canonical URLs, internal links, and sitemap entries. Keep `/app/` private/noindex; keep docs public. Validate output and the signup flow locally before deployment. Submit sitemap in Search Console after an authorized deployment.
2. **Next 30 days — publish proof, not volume.** Write one implementation note each for (a) approval before sandbox startup, (b) AI Gateway credential egress, and (c) the local end-to-end run including its gateway-auth limitation. Link each from the relevant docs and founder page. Include diagrams or code references and dated verification.
3. **Days 31–60 — answer adoption questions.** Improve quickstart and troubleshooting based on real setup friction. Publish a cost *surface* explainer using official pricing links and no invented bills. Ask contributors for concrete setup reports/issues, not generic testimonials.
4. **Days 61–90 — compare and update.** After a proven cloud run, publish an evidence-backed comparison with Devin Cloud (and other hosted agents where relevant). Recheck competitor docs before each revision. Update positioning if Shiba's actual workflow changes.

## Measurement and guardrails

- Baseline Search Console impressions, indexed pages, clicks and queries; review monthly rather than chasing daily fluctuations. Track `/why-shiba/` → `/waitlist/` visits and successful submissions without placing emails in analytics.
- Review `robots.txt`, sitemap, canonical URLs, broken internal links and mobile readability after each build. Validate structured data against the actual page content; no fabricated reviews, ratings, prices or “first” claim.
- Success in the first cycle is **qualified developer interest and useful contribution**, not a ranking promise. Count stored signups by interest privately; never publish email addresses or unverified popularity figures.

Search guidance: [Google helpful content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content), [sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).
