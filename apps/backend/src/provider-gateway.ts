
export const DUMMY_PROVIDER_KEY = "shiba-dummy-key";

/** Provider API headers that constrain the request shape, not the credential. */
// Transparent-proxy request headers: the gateway claims whatever the client
// claimed, so body encodings (gzip upload-pack, Connect-RPC compression) and
// protocol-version headers must reach upstream or the body is unparseable.
const PASSTHROUGH_HEADERS = [
  "content-type",
  "accept",
  "content-encoding",
  "grpc-encoding",
  "connect-protocol-version",
  "git-protocol",
  "user-agent",
  "anthropic-version",
  "anthropic-beta",
];

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
