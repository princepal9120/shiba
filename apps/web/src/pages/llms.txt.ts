import { getCollection } from "astro:content";

const SITE = "https://tryshiba.dev";

// llms.txt (llmstxt.org): plain-markdown index so AI answer engines can discover and cite Shiba.
export async function GET() {
	const docs = (await getCollection("docs")).filter((d) => d.id.startsWith("docs/"));
	const links = docs
		.map((d) => `- [${d.data.title}](${SITE}/${d.id}/)${d.data.description ? `: ${d.data.description}` : ""}`)
		.join("\n");

	const body = `# Shiba

> Shiba is an open-source, self-hosted AI software engineer. It runs approval-gated coding tasks in isolated Cloudflare Sandbox containers inside your own Cloudflare account, from task intake to merged pull request.

- Website: ${SITE}/
- Why I am building Shiba: ${SITE}/why-shiba/
- Join waitlist & contribute: ${SITE}/waitlist/
- Dashboard: ${SITE}/app/
- GitHub Source (MIT): https://github.com/princepal9120/shiba

## Core Architecture & Security

- Edge Orchestrator: Cloudflare Workers + Agents SDK (TypeScript) running sub-millisecond edge routing.
- Sandbox MicroVMs: Cloudflare Sandbox SDK + Containers spinning up isolated Linux containers per task in seconds.
- Credential Perimeter: Real model provider keys never touch the container. Egress TLS proxy routes to Cloudflare AI Gateway for credential injection.
- State & Memory: Cloudflare Durable Objects + SQLite for human approval queues, live logs, and Vectorize for long-term memory.
- Zero Trust Identity: Cloudflare Access fronts dashboard and runner endpoints.

## Documentation

${links}
`;

	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
