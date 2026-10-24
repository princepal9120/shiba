import type { DesktopViewName } from "@shiba/shared";

/** Hosted product the packaged app signs in to when no self-hosted URL is saved. */
export const HOSTED_ORIGIN = "https://app.tryshiba.dev";

export const DESKTOP_VIEWS: readonly DesktopViewName[] = [
  "tasks",
  "diff",
  "approvals",
  "providers",
  "remote",
];

/**
 * Unpackaged `SHIBA_DESKTOP_URL` wins when it is non-empty.
 * An explicit empty value, or `SHIBA_DESKTOP_SETUP=1`, opens the setup page.
 * Otherwise a saved origin is used, then the hosted product.
 */
export function resolveConfiguredOrigin(input: {
  packaged: boolean;
  envUrl: string | undefined;
  forceSetup: boolean;
  savedUrl: string | undefined;
  parse: (value: string, packaged: boolean) => string | null;
}): string {
  if (input.forceSetup) return "";
  if (!input.packaged && input.envUrl === "") return "";
  if (!input.packaged && input.envUrl) {
    return input.parse(input.envUrl, false) ?? "";
  }
  const saved = input.savedUrl ? input.parse(input.savedUrl, input.packaged) : null;
  if (saved) return saved;
  return HOSTED_ORIGIN;
}

/** Dashboard path for a view. `?run=` is intentionally omitted: the SPA treats it as the thread, not the diff tab. */
export function dashboardPath(view: DesktopViewName): string {
  if (view === "tasks") return "/app/";
  return `/app/?tab=${view}`;
}

export function isDesktopView(value: string): value is DesktopViewName {
  return (DESKTOP_VIEWS as readonly string[]).includes(value);
}
