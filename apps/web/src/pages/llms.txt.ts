import { getCollection } from "astro:content";
import { CATEGORY_LABEL, getPublishedPosts } from "../lib/journal";

const SITE = "https://tryshiba.dev";

// llms.txt (llmstxt.org): plain-markdown index so AI answer engines can discover and cite Shiba.
export async function GET() {
	const docs = (await getCollection("docs")).filter((d) => d.id.startsWith("docs/"));
	const links = docs
		.map((d) => `- [${d.data.title}](${SITE}/${d.id}/)${d.data.description ? `: ${d.data.description}` : ""}`)
		.join("\n");
	const posts = await getPublishedPosts();
	const postLinks = posts
		.map(
			(p) =>
				`- [${p.data.title}](${SITE}/blog/${p.id}/) (${CATEGORY_LABEL[p.data.category]}): ${p.data.description}`,
		)
		.join("\n");

	const body = `# Shiba

> Shiba is an open-source, self-hosted, approval-gated coding coworker and Devin Cloud alternative. It runs coding tasks in isolated Cloudflare Sandbox containers in your Cloudflare account. Review a diff, and optionally request a pull request when GitHub access is configured.

- Website: ${SITE}/
- Why I am building Shiba: ${SITE}/why-shiba/
- Journal (guides and engineering notes): ${SITE}/blog/
- Join waitlist & contribute: ${SITE}/waitlist/
- GitHub Source (AGPL-3.0-only): https://github.com/princepal9120/shiba

## Core Architecture & Security

- Edge Orchestrator: Cloudflare Workers + Agents SDK (TypeScript) routing requests at the edge.
- Sandbox containers: Cloudflare Sandbox SDK + Containers provide isolated Linux containers per task.
- Credentials: Provider credentials are added by Worker-side egress handling and are not passed into the sandbox process.
- State & Memory: Cloudflare Durable Objects + SQLite for human approval queues, live logs, and Vectorize for long-term memory.
- Access: Designed to sit behind operator-configured Cloudflare Access for dashboard and runner endpoints.

## Documentation

${links}
${
	posts.length > 0
		? `
## Journal

Long-form guides and engineering notes. Opinionated prose, same product claims as the docs.

${postLinks}
`
		: ""
}
`;

	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
