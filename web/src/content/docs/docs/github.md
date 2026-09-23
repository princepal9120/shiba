---
title: GitHub integration
description: Public cloning, optional publishing, and acknowledgment-only webhooks.
---

## Clone support

Use an HTTPS GitHub repository URL and its actual base branch (default main). Embedded credentials and other hosts are rejected.

**Private cloning is not implemented.** The Sandbox adapter calls gitCheckout without transport authorization. Setting GITHUB_TOKEN does not change that. Never embed credentials in the clone URL.

## Optional publishing

Publishing is off by default. The parent checks for GITHUB_TOKEN before a requested publish run starts. Use a least-privilege fine-grained token with Contents write and Pull requests write permissions on an owned test repository, subject to organization policies. See [GitHub token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

~~~sh
npx wrangler secret put GITHUB_TOKEN
~~~

The Worker creates blobs, a tree, a commit, an shiba-ai-coworker/<sandboxId> branch, and a PR via REST. It does not merge the PR or put the token in the container. API failures can leave branches/commits behind; inspect the repository before retrying.

### Fidelity limits

The publisher accepts captured contents, not a complete Git patch. Capture is bounded, deleted paths are not delete entries, and files are published with mode 100644. Deletions, renames, executable bits, and large-file preservation are not established. No-change publishing errors with “Nothing to publish”. Keep publishing off until the changes you intend to make have a validated round trip.

## Webhooks

Set GITHUB_WEBHOOK_SECRET and configure /api/github/webhook with the same secret, subject to deployment authentication. The handler verifies HMAC-SHA256 and acknowledges valid JSON. It does **not** create tasks, respond to issues, or auto-approve work.

Source: src/github.ts, src/agents/opencode-agent.ts, src/index.ts.

