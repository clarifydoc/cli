import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { mermaidLabel, idFactory } from "./mermaid-text.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SERVER_COPY = resolve(REPO_ROOT, "application/server/src/export/text.ts");

/**
 * Pull one exported function's source out of a module, by brace matching from
 * its signature. Enough for two hand-written functions; deliberately not a
 * parser.
 */
function functionSource(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  if (start === -1) throw new Error(`${name} is not exported from the file under test`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      seen = true;
    } else if (source[i] === "}") {
      depth--;
      if (seen && depth === 0) return source.slice(start, i + 1).replace(/\s+/g, " ");
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

/**
 * `application/server` is built and shipped on its own and cannot import the
 * engine (see `export/summary-source.ts`), so the two copies of the Mermaid
 * escaper are a structural duplication rather than an oversight. This is the
 * gate that keeps them one behaviour: change either and the build fails,
 * naming the other.
 *
 * Comparing source rather than behaviour is deliberate — a behavioural check
 * can only test the inputs someone thought of, and every escaping defect in
 * the graph export so far was a character nobody thought of.
 */
describe("the two Mermaid escapers are the same code", () => {
  const serverSource = readFileSync(SERVER_COPY, "utf8");
  const engineSource = readFileSync(resolve(__dirname, "mermaid-text.ts"), "utf8");

  for (const name of ["mermaidLabel", "idFactory"]) {
    it(`${name} is character-for-character identical in both packages`, () => {
      expect(functionSource(engineSource, name)).toBe(functionSource(serverSource, name));
    });
  }
});

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
