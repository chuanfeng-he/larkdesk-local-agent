import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_GEMINI_AUTH_TYPE,
  DEFAULT_GEMINI_CLI_MODEL,
  prepareGeminiCliArgs,
  prepareGeminiCliEnv,
} from "../packages/core/src/gemini-cli";
import { buildGeminiApiEndpoint } from "../packages/providers/gemini-api/src/index";

describe("gemini runtime helpers", () => {
  it("injects a stable default model for gemini cli when none is provided", () => {
    expect(prepareGeminiCliArgs([])).toEqual(["--model", DEFAULT_GEMINI_CLI_MODEL]);
  });

  it("preserves explicit gemini cli model overrides", () => {
    expect(prepareGeminiCliArgs(["--model", "gemini-2.5-pro"])).toEqual(["--model", "gemini-2.5-pro"]);
    expect(prepareGeminiCliArgs(["-m", "gemini-2.5-pro"])).toEqual(["-m", "gemini-2.5-pro"]);
  });

  it("isolates gemini cli auth state and prefers api key auth when a key is present", () => {
    const env = prepareGeminiCliEnv("/workspace", {
      GEMINI_API_KEY: "test-key",
      GOOGLE_GENAI_USE_GCA: "true",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
    });

    expect(env.GEMINI_CLI_HOME).toBe(join(
      tmpdir(),
      "office-agent",
      "gemini-cli",
      createHash("sha256").update("/workspace").digest("hex").slice(0, 12),
    ));
    expect(env.GEMINI_MODEL).toBe(DEFAULT_GEMINI_CLI_MODEL);
    expect(env.GEMINI_DEFAULT_AUTH_TYPE).toBe(DEFAULT_GEMINI_AUTH_TYPE);
    expect(env.GOOGLE_GENAI_USE_GCA).toBeUndefined();
    expect(env.GOOGLE_GENAI_USE_VERTEXAI).toBeUndefined();
  });

  it("builds the gemini api endpoint with the expected model path", () => {
    expect(buildGeminiApiEndpoint("gemini-2.0-flash"))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent");
    expect(buildGeminiApiEndpoint("models/gemini-2.5-flash"))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  });
});
