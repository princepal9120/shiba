import { getCollection } from 'astro:content';
import { getPublishedPosts } from '../lib/journal';

const SITE = 'https://tryshiba.dev';

export async function GET() {
	const docs = await getCollection('docs');
	const posts = await getPublishedPosts();
	const staticPages = [
		{ path: '/', changefreq: 'daily', priority: '1.0' },
		{ path: '/why-shiba/', changefreq: 'weekly', priority: '0.9' },
		{ path: '/waitlist/', changefreq: 'daily', priority: '0.9' },
		{ path: '/blog/', changefreq: 'weekly', priority: '0.8' },
	];

	// Posts are dated, so they change on their own cadence rather than with the
	// docs. Newer posts rank slightly higher.
	const postPages = posts.map((post, index) => ({
		path: `/blog/${post.id}/`,
		changefreq: 'monthly',
		priority: (0.7 - index * 0.01).toFixed(2),
	}));

	const docPages = docs
		.filter((d) => d.id !== '404')
		.map((d) => ({
			path: ('/' + d.id.replace(/(^|\/)index$/, '') + '/').replace(/\/+/g, '/'),
			changefreq: 'weekly',
			priority: '0.8',
		}));

	const uniquePaths = new Map();
	for (const p of [...staticPages, ...docPages, ...postPages]) {
		if (p.path.startsWith('/404')) continue;
		if (!uniquePaths.has(p.path)) {
			uniquePaths.set(p.path, { changefreq: p.changefreq, priority: p.priority });
		}
	}

	const urls = [...uniquePaths.entries()]
		.map(
			([path, meta]) =>
				'  <url>\n    <loc>' + SITE + path + '</loc>\n    <changefreq>' + meta.changefreq + '</changefreq>\n    <priority>' + meta.priority + '</priority>\n  </url>',
		)
		.join('\n');

	return new Response(
		'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + '\n</urlset>\n',
		{ headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
	);
}
