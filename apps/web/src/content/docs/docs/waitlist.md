---
title: Waitlist and contributor signups
description: How the public Shiba signup form stores entries and how the operator exports or removes them.
---

The public `/waitlist/` page invites launch-update subscribers and contributors. It does **not** gate access to the open-source code. The page POSTs to `/api/waitlist` on the same Worker; Astro's standalone `docs:dev` server does not implement that API, so test the form through the built Worker.

Entries are stored in the SQLite-backed `Waitlist` Durable Object, one row per normalized email: email, interest (`early-access`, `contribute`, `both`, `pro-plan`, or `team-plan`), optional GitHub username, and signup time. No signup data is returned to the public endpoint. Repeated signups return `alreadyJoined: true` without duplicating a row. The public endpoint requires a same-origin JSON POST, validates fields and consent, rejects a populated honeypot field, limits request bodies to 4 KiB, and allows at most five attempts per hashed-IP/hour bucket. This is basic abuse protection, **not** a substitute for Cloudflare WAF/Turnstile at scale.

The owner can export the first 1,000 newest entries with `GET /api/admin/waitlist` or delete one with `DELETE /api/admin/waitlist` and JSON `{ "email": "person@example.com" }`. Both routes require the normal Cloudflare Access identity in a live deployment. Never publish the response, paste it into issues, or expose it to an agent/container. There is no automatic email sending or CSV export. A signup is only stored if the API responds successfully; failures remain errors.

The Access policy protects `/app`, `/api`, `/agents`, and `/mcp` paths. Its narrowly scoped `/api/waitlist` bypass permits only the public signup path at the edge; Worker routing permits unauthenticated **POST only**. Public pages and docs remain crawlable. After deployment, verify the Access policy on the actual custom domain as well as the Workers subdomain—do not assume the policy created for one hostname protects another.
