/**
 * Secret-shape scrubbing — pure TypeScript, no Worker or DOM deps, so it
 * lives in shared and every surface (Worker logs, auth flow records,
 * package tooling) redacts with the same pattern set.
 */
const SECRET_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{8,}/g,
  /gho_[A-Za-z0-9]{8,}/g,
  /ghu_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /AIza[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9]{8,}/g,
  /xox[bpas]-[A-Za-z0-9-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
  /api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{8,}['"]?/gi,
  /AI_GATEWAY_TOKEN\s*[:=]\s*[A-Za-z0-9._~+/-]{8,}/gi,
];

/** Replace known secret shapes with [redacted]. Safe to run on any text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}
