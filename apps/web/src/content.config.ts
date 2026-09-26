import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';
// `z` re-exported from `astro:content` is deprecated in Astro 7; the supported
// import is the versioned zod entrypoint.
import { z } from 'astro/zod';

const journalSchema = z.object({
	title: z.string(),
	description: z.string(),
	// Publication date, ISO `YYYY-MM-DD`.
	pubDate: z.coerce.date(),
	// Optional edit date. Rendered as "Updated" only when present.
	updatedDate: z.coerce.date().optional(),
	// Editorial category. Three values, matching the zuse.sh Journal shape:
	// guide (teaches an evaluation method), journal (a build log entry),
	// note (a short opinion or clarification).
	category: z.enum(['guide', 'journal', 'note']),
	// Which canonical narrative pattern the post uses. Surfaced in the
	// article header so the structure is legible rather than implied.
	pattern: z.enum([
		'protagonist-arc',
		'choreography',
		'situation-complication-resolution',
		'what-is-what-could-be',
	]),
	// One line, plain text, shown on the index card. No markdown.
	summary: z.string(),
});

// Journal (/blog): long-form guides and engineering notes. Kept separate from
// `docs` because the two have different contracts — docs are reference and
// versioned with the code, the Journal is dated editorial prose about Shiba.
const journal = defineCollection({
	// Posts are addressed as /blog/<slug>/, so pin the entry id to the file stem
	// rather than depending on the loader's path-relative default.
	loader: glob({
		pattern: '**/*.md',
		base: './src/content/journal',
		generateId: ({ entry }) => entry.replace(/\.md$/, ''),
	}),
	schema: journalSchema,
});

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
	journal,
};
