import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import assert from "node:assert/strict";

const root = resolve("public");
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? walk(join(dir, entry.name)) : [join(dir, entry.name)]))).flat();
}
const files = await walk(root);
const pages = files.filter(file => file.endsWith(".html"));
assert(pages.length >= 15, "Expected all documentation pages and a 404 page");
for (const path of ["index.html", "404.html", "docs/overview/index.html", "pagefind/pagefind.js", "app/index.html"]) {
  assert((await stat(join(root, path))).isFile(), "Missing output: " + path);
}
let links = 0;
const failures = [];
for (const file of pages) {
  const html = await readFile(file, "utf8");
  const base = "https://docs.local/" + relative(root, file).replace(/index\.html$/, "");
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = new URL(match[1].replaceAll("&amp;", "&"), base);
    if (url.origin !== "https://docs.local") continue;
    const path = decodeURIComponent(url.pathname);
    let target = resolve(root, "." + path);
    assert(target.startsWith(root + "/") || target === root, "Path escapes build output");
    try {
      if ((await stat(target)).isDirectory()) target = join(target, "index.html");
      await stat(target);
      if (url.hash && target.endsWith(".html")) {
        const body = await readFile(target, "utf8");
        const id = decodeURIComponent(url.hash.slice(1));
        assert(body.includes('id="' + id + '"'), "Missing anchor " + id);
      }
      links++;
    } catch (error) {
      failures.push(relative(root, file) + " -> " + match[1] + ": " + error.message);
    }
  }
}
assert.equal(failures.length, 0, failures.join("\n"));
console.log("Verified " + pages.length + " HTML pages, " + links + " local links/assets/anchors, and Pagefind output.");

// Stale-claim check (VERIFICATION_PLAN §3): the docs source must not
// resurrect removed claims. Each pattern is verified against the current
// tree — anything listed here must produce zero matches.
function negated(text, index) {
  // "There is no provider callback" documents the deleted route honestly;
  // only an affirmative mention is stale. Negation must appear in the same
  // sentence — newlines do not end a sentence because prose is hard-wrapped.
  const before = text.slice(0, index);
  const clause = Math.max(
    before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"),
    before.lastIndexOf(";"), before.lastIndexOf(":"), before.lastIndexOf("|"),
  ) + 1;
  return /\b(?:no|not|never|without|nor|nonexistent|n't)\b/i.test(before.slice(clause));
}
const staleClaims = [
  // Case-sensitive: "Worker origin" (the hostname) is legit prose; the env
  // var spelling is the removed claim.
  { re: /WORKER_ORIGIN/g, note: "removed env var" },
  { re: /gemini-2\.0/gi, note: "retired model id" },
  { re: /only google/gi, note: "provider-lock claim" },
  { re: /provider callback/gi, note: "deleted 503 callback path", allow: negated },
];
const docsRoot = resolve("apps/web/src/content/docs");
const markdown = (await walk(docsRoot)).filter(file => /\.(md|mdx)$/.test(file));
const stale = [];
for (const file of markdown) {
  const text = await readFile(file, "utf8");
  for (const { re, note, allow } of staleClaims) {
    for (const match of text.matchAll(re)) {
      if (allow && allow(text, match.index)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      stale.push(relative(docsRoot, file) + ":" + line + " matches " + re + " (" + note + ")");
    }
  }
}
assert.equal(stale.length, 0, stale.join("\n"));
console.log("Checked " + markdown.length + " markdown files for stale claims.");
