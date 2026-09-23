import { describe, expect, it } from "vitest";
import * as providerGateway from "../src/provider-gateway.js";

describe("provider-gateway exports", () => {
  it("no longer exports forwardProviderRequest — dead callback path deleted", () => {
    expect("forwardProviderRequest" in providerGateway).toBe(false);
  });
});
