import { describe, expect, it } from "vitest";
import { sanitizeContainerHeaders, stripCredentialParams } from "../src/provider-gateway.js";

describe("sanitizeContainerHeaders", () => {
  it("keeps request-shape headers including the Anthropic version header", () => {
    const incoming = new Headers({
      "content-type": "application/json",
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
    });
    const headers = sanitizeContainerHeaders(incoming);
    expect([...headers.keys()].sort()).toEqual([
      "accept",
      "anthropic-beta",
      "anthropic-version",
      "content-type",
    ]);
  });

  it("strips every credential-bearing header", () => {
    const incoming = new Headers({
      authorization: "Bearer real-key",
      "x-api-key": "real-key",
      "cf-aig-authorization": "Bearer real-key",
      cookie: "session=1",
      "content-type": "application/json",
    });
    const headers = sanitizeContainerHeaders(incoming);
    expect([...headers.keys()]).toEqual(["content-type"]);
  });

  it("omits absent headers rather than sending empty values", () => {
    expect([...sanitizeContainerHeaders(new Headers()).keys()]).toEqual([]);
  });
});

describe("stripCredentialParams", () => {
  it("removes key-bearing query params", () => {
    expect(stripCredentialParams("?key=secret&alt=json")).toBe("alt=json");
    expect(stripCredentialParams("?api_key=secret&APIKEY=secret&q=1")).toBe("q=1");
  });

  it("leaves ordinary params alone", () => {
    expect(stripCredentialParams("?alt=sse")).toBe("alt=sse");
    expect(stripCredentialParams("")).toBe("");
  });
});
