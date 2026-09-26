import { getCollection, render, type CollectionEntry } from 'astro:content';

// `render()` already returns the heading list; its element type is structural,
// so the local shape below keeps the public surface of this module free of a
// deep internal import.
export interface MarkdownHeading {
	depth: number;
	slug: string;
	text: string;
}

export type JournalPost = CollectionEntry<'journal'>;

export interface TocItem {
	depth: number;
	slug: string;
	text: string;
}

export const CATEGORY_LABEL: Record<JournalPost['data']['category'], string> = {
	guide: 'Guide',
	journal: 'Journal',
	note: 'Note',
};

export const PATTERN_LABEL: Record<JournalPost['data']['pattern'], string> = {
	'protagonist-arc': 'Protagonist arc',
	choreography: 'Choreography',
	'situation-complication-resolution': 'Situation → complication → resolution',
	'what-is-what-could-be': 'What is / what could be',
};

/** Newest first. Ties break on title so ordering is stable across builds. */
export function byDateDesc(a: JournalPost, b: JournalPost): number {
	const delta = b.data.pubDate.getTime() - a.data.pubDate.getTime();
	return delta !== 0 ? delta : a.data.title.localeCompare(b.data.title);
}

/**
 * Reading time at 220wpm. Counts prose only: fenced code and heading markers
 * are stripped first so a long shell sample does not inflate the estimate.
 */
export function readingTime(body: string | undefined): number {
	const words = (body ?? '')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`[^`]*`/g, ' ')
		.replace(/^#{1,6}\s.*$/gm, ' ')
		.split(/\s+/)
		.filter(Boolean).length;
	return Math.max(1, Math.round(words / 220));
}

function slugify(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/`/g, '')
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/\s+/g, '-');
}

/**
 * Builds the "On this page" list from the rendered h2/h3 elements. Reading the
 * DOM rather than re-parsing markdown keeps this in step with whatever
 * rehype plugins are active (heading ids included), so no anchor can drift.
 */
function collectToc(headings: readonly MarkdownHeading[]): TocItem[] {
	return headings
		.filter((h) => h.depth === 2 || h.depth === 3)
		.map((h) => ({ depth: h.depth, slug: h.slug, text: h.text }));
}

export async function getPublishedPosts(): Promise<JournalPost[]> {
	const posts = await getCollection('journal');
	return posts.sort(byDateDesc);
}

export interface RenderedPost {
	post: JournalPost;
	Content: (props: Record<string, unknown>) => unknown;
	headings: MarkdownHeading[];
	toc: TocItem[];
	minutes: number;
	path: string;
}

export async function renderPost(post: JournalPost): Promise<RenderedPost> {
	const { Content, headings } = await render(post);
	return {
		post,
		Content: Content as RenderedPost['Content'],
		headings,
		toc: collectToc(headings),
		minutes: readingTime(post.body),
		path: `/blog/${post.id}/`,
	};
}

export { slugify };
