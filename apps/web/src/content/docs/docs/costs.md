---
title: Costs and limits
description: Account-owned usage without invented prices.
---

Resources include Workers requests, Workers AI planning inference, Durable Object storage/execution, Containers compute, coding inference through the supported AI Gateway/provider arrangement, and GitHub API quotas.

No prices or free-use guarantees are stated here. Check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Containers pricing](https://developers.cloudflare.com/containers/pricing/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), and [AI Gateway](https://developers.cloudflare.com/ai-gateway/).

## Application limits

| Limit | Value |
| --- | --- |
| Active registry runs / configured containers | 3 |
| OpenCode timeout | 15 minutes |
| Git command timeout | 5 minutes |
| Collected diff | 120,000 characters |
| Transcript diff display | 20,000 characters |
| stderr tail | 8,000 characters |
| Captured files | 50 |
| Per-file captured contents | 100,000 characters |
| Total captured contents | 500,000 characters |

Source: src/runtime.ts and src/transcript.ts. These are application settings, not Cloudflare plan quotas or guaranteed in-memory read bounds. Capture truncation can make publication incomplete.

Set account budgets and alerts where supported. Clearing history does not stop resource billing, and cancellation is best-effort. Verify container lifecycle in your account.

