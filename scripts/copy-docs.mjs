import { cp, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Copy the built Astro site into public/ so the Worker serves them
// alongside the dashboard. Runs after both vite build and astro build.
const src = new URL('../apps/web/dist', import.meta.url);
const dest = new URL('../public', import.meta.url);

await mkdir(dirname(dest.pathname), { recursive: true });
await cp(src.pathname, dest.pathname, { recursive: true, force: true });
console.log('Copied apps/web/dist -> public');

