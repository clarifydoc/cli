import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeTextFile } from "./output-writer.js";

describe("writeTextFile", () => {
  it("writes the bytes writeFile would, with a surrogate pair on a slice boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-text-"));
    try {
      const slice = 1 << 23;
      // A pair straddling the first slice end, a lone high surrogate at the second, a pair at the very end.
      const text = "a".repeat(slice - 1) + "\u{1F3C6}" + "b".repeat(slice - 2) + "\ud83c" + "c".repeat(100) + "\u{26BD}\u{1F697}";
      const path = join(dir, "big.json");
      await writeTextFile(path, text);
      expect(Buffer.compare(readFileSync(path), Buffer.from(text, "utf-8"))).toBe(0);
      await writeTextFile(path, "");
      expect(readFileSync(path).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
