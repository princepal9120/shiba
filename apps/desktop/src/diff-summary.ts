export const MAX_PATCH_CHARS = 512 * 1024;

export interface DiffSummary {
  files: string[];
  hunks: number;
  additions: number;
  deletions: number;
}

export type DiffParse = { ok: true; summary: DiffSummary } | { ok: false; error: string };

/** Counts files, hunks, and line changes in a unified diff. Does not store the patch. */
export function summarizeUnifiedDiff(patch: string): DiffParse {
  if (patch.length === 0) return { ok: false, error: "Diff is empty." };
  if (patch.length > MAX_PATCH_CHARS) return { ok: false, error: "Diff is too large." };
  if (patch.includes("\0")) return { ok: false, error: "Diff is not text." };
  const files: string[] = [];
  let hunks = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(\S+)$/.exec(line);
      if (match?.[1]) files.push(match[1]);
    } else if (line.startsWith("@@")) {
      hunks += 1;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  if (files.length === 0 && hunks === 0) {
    return { ok: false, error: "Diff is not a unified patch." };
  }
  return { ok: true, summary: { files, hunks, additions, deletions } };
}
