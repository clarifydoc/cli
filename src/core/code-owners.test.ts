import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCodeOwners, ownersOf } from "./code-owners.js";

describe("CODEOWNERS", () => {
  it("reads .github/CODEOWNERS and lets the last matching rule win", () => {
    const root = mkdtempSync(join(tmpdir(), "codeowners-"));
    try {
      mkdirSync(join(root, ".github"));
      writeFileSync(join(root, ".github", "CODEOWNERS"), [
        "# owners",
        "*            @org/everyone",
        "/api/        @org/backend",
        "*.vue        @org/frontend  # inline comment",
        "/api/vendor/",
        "[Docs]",
        "docs/**      jane@example.com",
      ].join("\n"));
      const co = loadCodeOwners(root)!;
      expect(co.file).toBe(".github/CODEOWNERS");
      expect(ownersOf(co.rules, "api/users.ts")).toEqual(["@org/backend"]);
      expect(ownersOf(co.rules, "web/src/App.vue")).toEqual(["@org/frontend"]);
      expect(ownersOf(co.rules, "api/vendor/lib.js")).toEqual([]);
      expect(ownersOf(co.rules, "docs/a/b.md")).toEqual(["jane@example.com"]);
      expect(ownersOf(co.rules, "README.md")).toEqual(["@org/everyone"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
