
export const DUMMY_PROVIDER_KEY = "shiba-ai-coworker-dummy-key";
export const GOOGLE_API_HOST = "generativelanguage.googleapis.com";

/** Provider API headers that constrain the request shape, not the credential. */
const PASSTHROUGH_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"];

export function sanitizeContainerHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  for (const name of PASSTHROUGH_HEADERS) {
    const value = incoming.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export function stripCredentialParams(query: string): string {
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) {
    if (["key", "api_key", "apikey"].includes(key.toLowerCase())) params.delete(key);
  }
  return params.toString();
}
