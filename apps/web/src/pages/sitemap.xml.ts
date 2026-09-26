import { getCollection } from 'astro:content';

const SITE = 'https://tryshiba.dev';
const TODAY = '2026-09-26';

export async function GET() {
	const docs = await getCollection('docs');
	const staticPages = [
		{ path: '/', changefreq: 'daily', priority: '1.0' },
		{ path: '/why-shiba/', changefreq: 'weekly', priority: '0.9' },
		{ path: '/waitlist/', changefreq: 'daily', priority: '0.9' },
	];

	const docPages = docs.map((d) => ({
		path: ('/' + d.id.replace(/(^|\/)index$/, '') + '/').replace(/\/+/g, '/'),
		changefreq: 'weekly',
		priority: '0.8',
	}));

	const uniquePaths = new Map();
	for (const p of [...staticPages, ...docPages]) {
		if (!uniquePaths.has(p.path)) {
			uniquePaths.set(p.path, { changefreq: p.changefreq, priority: p.priority });
		}
	}

	const urls = [...uniquePaths.entries()]
		.map(
			([path, meta]) =>
				'  <url>\n    <loc>' + SITE + path + '</loc>\n    <lastmod>' + TODAY + '</lastmod>\n    <changefreq>' + meta.changefreq + '</changefreq>\n    <priority>' + meta.priority + '</priority>\n  </url>',
		)
		.join('\n');

	return new Response(
		'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + '\n</urlset>\n',
		{ headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
	);
}
