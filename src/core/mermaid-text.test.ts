import { describe, it, expect } from "vitest";
import { mermaidLabel, idFactory } from "./mermaid-text.js";

describe("mermaidLabel", () => {
  it("escapes every character Mermaid reads as syntax inside a label", () => {
    // `"` ends a quoted label, `#` opens Mermaid's own entity escape, and
    // `<`/`>` are markup. A raw newline ends the statement.
    expect(mermaidLabel('a "b" c')).toBe("a #quot;b#quot; c");
    expect(mermaidLabel("a # b")).toBe("a #35; b");
    expect(mermaidLabel("a <b> c")).toBe("a #lt;b#gt; c");
    expect(mermaidLabel("a\nb")).toBe("a b");
    expect(mermaidLabel("a\r\nb")).toBe("a b");
  });

  it("escapes the # of its own escapes first, so they cannot be forged", () => {
    // Were `"` handled before `#`, this input would come back as a literal
    // `#quot;` that Mermaid renders as a quote the source never contained.
    expect(mermaidLabel("#quot;")).toBe("#35;quot;");
  });

  it("survives nullish and non-string input", () => {
    expect(mermaidLabel(null)).toBe("");
    expect(mermaidLabel(undefined)).toBe("");
    expect(mermaidLabel(42)).toBe("42");
  });
});

describe("idFactory", () => {
  it("never merges two different keys that sanitize alike", () => {
    const id = idFactory("n");
    const a = id("app/user.ts");
    const b = id("app-user.ts");
    expect(a).not.toBe(b);
    // …and the same key always comes back to the same id.
    expect(id("app/user.ts")).toBe(a);
  });

  it("produces ids Mermaid can parse", () => {
    const id = idFactory("n");
    for (const key of ["9lives", "", "---", "a b c", "üñî"]) {
      expect(id(key)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });
});
