#!/usr/bin/env node
/**
 * Validates the decision table in docs/cf-open-agents-patterns.md:
 *  - COPY rows must name repo files (src/…, test/…, docs/… .ts|.tsx|.mjs|.md)
 *    that exist.
 *  - SKIP/ADAPT/WATCH rows must carry a non-empty flip criterion.
 *
 * Usage: node scripts/check-cf-patterns-doc.mjs [--doc=<path>]
 * Exit 0 on clean, 1 with the problem list on violations.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docArg = process.argv.find((arg) => arg.startsWith("--doc="));
const docPath = resolve(root, docArg ? docArg.slice("--doc=".length) : "docs/cf-open-agents-patterns.md");

let text;
try {
  text = readFileSync(docPath, "utf8");
} catch {
  console.error(`check-cf-patterns-doc: cannot read ${docPath}`);
  process.exit(1);
}

const rows = text
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("|") && line.endsWith("|"))
  .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()))
  .filter((cells) => cells.length >= 4)
  // drop header and separator rows
  .filter((cells) => !/^pattern$/i.test(cells[0]) && !/^[-: ]+$/.test(cells[0]));

const problems = [];
if (rows.length === 0) problems.push("no decision-table rows parsed");

const PATH_TOKEN = /`?((?:src|test|docs|scripts)\/[^\s`)]*?\.(?:ts|tsx|mjs|md))`?/g;

for (const cells of rows) {
  const [pattern, verdict, rationale, flip] = cells;
  if (/^COPY/i.test(verdict)) {
    const named = [...(rationale ?? "").matchAll(PATH_TOKEN)].map((m) => m[1]);
    if (named.length === 0) {
      problems.push(`COPY row "${pattern}" names no repo file path`);
    }
    for (const p of named) {
      if (!existsSync(resolve(root, p))) {
        problems.push(`COPY row "${pattern}" names missing file: ${p}`);
      }
    }
  }
  if (/^(SKIP|ADAPT|WATCH)/i.test(verdict)) {
    const f = (flip ?? "").replace(/`/g, "").trim();
    if (!f || f === "—" || f === "-" || /^n\/?a\.?$/i.test(f)) {
      problems.push(`${verdict} row "${pattern}" lacks a flip criterion`);
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`check-cf-patterns-doc: ${p}`);
  process.exit(1);
}
console.log(`check-cf-patterns-doc: ${rows.length} rows OK`);
