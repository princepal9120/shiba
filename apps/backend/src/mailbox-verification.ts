/**
 * Verification-mail extraction for the agent mailbox identity: pull
 * one-time codes and magic sign-in links out of a received body so the
 * agent can complete third-party logins during a run without the raw
 * body ever entering its context.
 *
 * Every input string here is untrusted mail content, so the same rules
 * `flagLinks`/`wrapUntrusted` carry apply: all scanning is regex-bounded
 * (no backtracking beyond the next delimiter), and outputs stay verbatim
 * substrings — a code, a link, never prose the mail can steer.
 */
import { extractLinks, type ExtractedLink } from "./mailbox-store.js";

/**
 * Operator default for the agent's mailbox address — the address the
 * deployment's runs receive verification mail at. `AGENT_MAILBOX`
 * overrides per deployment; register the address in the Inbox and
 * assign it to the agent principal for the tools to see it.
 */
export const DEFAULT_AGENT_MAILBOX = "dev@tryshiba.dev";

/**
 * The mailbox `latest_verification` scans when no `mailbox` arg is
 * given — the agent's configured identity address. A malformed or
 * unregistered value still flows to the store probe, which answers
 * with the usual "not available to this agent" refusal.
 */
export function agentMailbox(env: { AGENT_MAILBOX?: string }): string {
  const configured = env.AGENT_MAILBOX?.trim().toLowerCase();
  return configured === undefined || configured === "" ? DEFAULT_AGENT_MAILBOX : configured;
}

/**
 * Words that make a bare digit run plausible as a verification code
 * ("your code is…", "sign-in", "one-time"). Word stems cover the common
 * inflections (verify/verification, confirm/confirmation, …).
 */
const VERIFICATION_WORD_RE =
  /\b(?:code|otp|passcode|pin|token|verif\w*|one[\s-]?time|sign[\s-]?in|log[\s-]?in|magic|confirm\w*|activat\w*|security|auth\w*)\b/i;

/** "code is 123456" / "OTP: 123456" / "pin — 123456". */
const LABELED_DIGIT_RE =
  /\b(?:code|otp|passcode|pin|token)\s*(?:is|=|:|[-–—])\s*["'`]?(\d{4,10})\b/i;
/** "123456 is your verification code". */
const REVERSED_DIGIT_RE =
  /\b(\d{4,10})\s+is\s+your\s+(?:[\w-]+\s+){0,4}(?:code|otp|passcode|pin|token)\b/i;
/**
 * "code is AB12-CD34" — backup-code token shapes. The capture runs
 * case-insensitively so the label can be titled ("Code is…"), and the
 * candidate is then required to be uppercase-or-digit so a prose word
 * ("code is your…") cannot qualify.
 */
const LABELED_TOKEN_RE =
  /\b(?:code|otp|passcode|pin|token)\s*(?:is|=|:|[-–—])\s*["'`]?([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)\b/i;
const TOKEN_SHAPE_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

/** Standalone digit runs, proximity-checked against a verification word. */
const CODE_CANDIDATE_RE = /\b\d{4,8}\b/g;
const CODE_PROXIMITY = 64;

function extractCode(text: string): string | null {
  const digit = LABELED_DIGIT_RE.exec(text)?.[1];
  if (digit !== undefined) {
    return digit;
  }
  const reversed = REVERSED_DIGIT_RE.exec(text)?.[1];
  if (reversed !== undefined) {
    return reversed;
  }
  const token = LABELED_TOKEN_RE.exec(text)?.[1];
  if (token !== undefined && TOKEN_SHAPE_RE.test(token)) {
    return token;
  }
  if (VERIFICATION_WORD_RE.test(text)) {
    for (const match of text.matchAll(CODE_CANDIDATE_RE)) {
      const start = match.index;
      const window = text.slice(
        Math.max(0, start - CODE_PROXIMITY),
        start + match[0].length + CODE_PROXIMITY,
      );
      if (VERIFICATION_WORD_RE.test(window)) {
        return match[0];
      }
    }
  }
  return null;
}

/**
 * Words in a URL host/path/query marking a one-click action link —
 * verify, confirm, sign-in, magic, token, invite, reset. Over-inclusive
 * by design: an oauth/callback URL is exactly the link the agent is
 * hunting for, and the `flags` it carries still mark unsafe hosts.
 */
const MAGIC_URL_RE =
  /(?:verif|confirm|token|magic|sign[._-]?in|log[._-]?in|auth|activat|invit|register|reset|otp|code|callback|continue|complete|accept)/i;
/** Action verbs in anchor text marking a click-to-act link. */
const MAGIC_ANCHOR_RE =
  /\b(?:sign[ -]?in|log[ -]?in|verify|confirm|activate|get started|accept|continue|complete|reset|claim|authori[sz]e|authenticate|magic|join|finish|redeem)\b/i;

const MAX_MAGIC_LINKS = 20;

function isMagicLink(link: ExtractedLink): boolean {
  let haystack = link.url;
  try {
    const url = new URL(link.url);
    haystack = `${url.hostname}${url.pathname}${url.search}`;
  } catch {
    // Unparseable address — classify on the raw string.
  }
  if (MAGIC_URL_RE.test(haystack)) {
    return true;
  }
  return link.anchor_text !== null && MAGIC_ANCHOR_RE.test(link.anchor_text);
}

// Tag/entity stripping mirrors TAG_RE in mailbox-store so a digit run
// inside an attribute (`width="1160"`) cannot pass as a code.
const TAG_STRIP_RE = /<[^<>]*>/g;
const ENTITY_RE = /&[a-zA-Z0-9#]{1,8};/g;
const stripHtml = (html: string) =>
  html.replace(TAG_STRIP_RE, " ").replace(ENTITY_RE, " ");

export interface VerificationExtraction {
  /** The one-time code found in the body, or `null` when none is labeled or near a verification word. */
  code: string | null;
  /** Magic sign-in/verify links, deduped by URL, each carrying its link flags. */
  magic_links: ExtractedLink[];
}

/**
 * Scan a stored email's bodies for verification signals. `body_text`
 * wins over `body_html` (labeled hits in the plain body beat anything
 * reconstructed from markup); links are extracted from both, first
 * occurrence per URL kept.
 */
export function extractVerificationSignals(
  bodyText: string | null,
  bodyHtml: string | null,
): VerificationExtraction {
  const texts = [bodyText, bodyHtml === null ? null : stripHtml(bodyHtml)].filter(
    (text): text is string => text !== null && text.trim() !== "",
  );
  let code: string | null = null;
  for (const text of texts) {
    code = extractCode(text);
    if (code !== null) {
      break;
    }
  }
  const magicLinks = new Map<string, ExtractedLink>();
  for (const source of [bodyText, bodyHtml]) {
    if (source === null) {
      continue;
    }
    for (const link of extractLinks(source)) {
      if (!isMagicLink(link) || magicLinks.has(link.url)) {
        continue;
      }
      magicLinks.set(link.url, link);
      if (magicLinks.size >= MAX_MAGIC_LINKS) {
        return { code, magic_links: [...magicLinks.values()] };
      }
    }
  }
  return { code, magic_links: [...magicLinks.values()] };
}
