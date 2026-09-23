import { getCollection } from 'astro:content';

const SITE = 'https://tryshiba.dev';

// llms.txt (llmstxt.org): plain-markdown index so AI answer engines can find and cite the docs.
export async function GET() {
	const docs = (await getCollection('docs')).filter((d) => d.id.startsWith('docs/'));
	const links = docs
		.map((d) => `- [${d.data.title}](${SITE}/${d.id}/)${d.data.description ? `: ${d.data.description}` : ''}`)
		.join('\n');
	const body = `# Shiba

> Shiba is an open-source, self-hosted AI software engineer. It runs approval-gated coding tasks in isolated Cloudflare Sandbox containers on your own Cloudflare account, from task to merged pull request.

- Website: ${SITE}/
- Dashboard: ${SITE}/app/
- Source (MIT): https://github.com/princepal9120/shiba

## Docs

${links}
`;
	return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
