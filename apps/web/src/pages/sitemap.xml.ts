import { getCollection } from 'astro:content';

const SITE = 'https://tryshiba.dev';

export async function GET() {
	const docs = await getCollection('docs');
	const paths = ['/', ...docs.map((d) => `/${d.id.replace(/(^|\/)index$/, '')}/`.replace(/\/+/g, '/'))];
	const urls = [...new Set(paths)].map((p) => `  <url><loc>${SITE}${p}</loc></url>`).join('\n');
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
		{ headers: { 'Content-Type': 'application/xml' } },
	);
}
