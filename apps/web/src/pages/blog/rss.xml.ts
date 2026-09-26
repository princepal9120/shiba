import { getPublishedPosts } from '../../lib/journal';

const SITE = 'https://tryshiba.dev';

const escape = (value: string) =>
	value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

export async function GET() {
	const posts = await getPublishedPosts();

	const items = posts
		.map((post) => {
			const url = `${SITE}/blog/${post.id}/`;
			return [
				'    <item>',
				`      <title>${escape(post.data.title)}</title>`,
				`      <link>${url}</link>`,
				`      <guid isPermaLink="true">${url}</guid>`,
				`      <description>${escape(post.data.description)}</description>`,
				`      <pubDate>${post.data.pubDate.toUTCString()}</pubDate>`,
				'    </item>',
			].join('\n');
		})
		.join('\n');

	const body = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
		'  <channel>',
		'    <title>Shiba Journal</title>',
		`    <link>${SITE}/blog/</link>`,
		'    <description>Guides and engineering notes on running approval-gated coding agents in your own Cloudflare account.</description>',
		'    <language>en</language>',
		`    <atom:link href="${SITE}/blog/rss.xml" rel="self" type="application/rss+xml" />`,
		items,
		'  </channel>',
		'</rss>',
		'',
	].join('\n');

	return new Response(body, {
		headers: { 'Content-Type': 'application/xml; charset=utf-8' },
	});
}
