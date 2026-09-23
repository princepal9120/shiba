import { describe, expect, it } from "vitest";
import { assertLiveCodingModel } from "../src/coding-model.js";
import type { Env } from "../src/env.js";

function env(codingModel: string): Env {
  return { CODING_MODEL: codingModel } as Env;
}

describe("assertLiveCodingModel", () => {
  it("throws on the retired gemini-2.0-flash id", () => {
    expect(() => assertLiveCodingModel(env("google/gemini-2.0-flash"))).toThrow(/retired/);
  });

  it("allows the wrangler default", () => {
    expect(() => assertLiveCodingModel(env("google/gemini-3.5-flash-lite"))).not.toThrow();
  });
});
