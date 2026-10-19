import { describe, expect, it } from "vitest";
import { secretsInLog } from "./history-secrets.js";

describe("secretsInLog", () => {
  it("finds credentials on added lines, with commit, file and line, masked", () => {
    const log = [
      "\u0000abc1234 2024-03-01",
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -10,0 +11,2 @@",
      '+export const region = "eu";',
      '+const key = "AKIA4Q2W7XZPLM3NB6RT";',
      "-const old = 1;",
      "\u0000def5678 2024-02-01",
      "+++ b/package-lock.json",
      "@@ -1 +1 @@",
      '+"integrity": "AKIA4Q2W7XZPLM3NB6RU"',
      "+++ b/docs/setup.md",
      "@@ -1 +3 @@",
      "+Use a key like AKIAIOSFODNN7EXAMPLE in your env.",
    ].join("\n");
    const got = secretsInLog(log).map(({ raw: _raw, ...s }) => s);
    expect(got).toEqual([
      { format: "AWS access key", commit: "abc1234", date: "2024-03-01", file: "src/config.ts", line: 12, snippet: expect.not.stringContaining("AKIA4Q2W7XZPLM3NB6RT") },
    ]);
  });
});
