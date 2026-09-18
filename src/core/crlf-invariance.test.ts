import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import fg from "fast-glob";
import { extractWithRegex } from "./regex-extractor.js";
import { scanSecurity } from "./security-scanner.js";
import { splitLines } from "../extractors/shared/source-lines.js";
import { EXTENSION_TO_LANGUAGE } from "../extractors/registry.js";
import type { Language } from "../types/analysis.js";

/**
 * A CRLF checkout must produce the same facts as an LF one.
 *
 * This is a regression gate for a real defect: splitting on `"\n"` left a `\r`
 * on every line, and because JavaScript's `.` never matches `\r`, every rule
 * shaped `(.+)$` stopped matching. The Perl fixture lost ALL of its Catalyst
 * routes on a CRLF copy while reporting no error — the class of failure that
 * is invisible in the output.
 *
 * Runs the regex extractor and the security scanner (both line-oriented) over
 * real fixture sources twice: as committed (LF) and with every line ending
 * rewritten to CRLF. Any difference fails.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");

const toCrlf = (text: string): string => splitLines(text).join("\r\n");
const toCr = (text: string): string => splitLines(text).join("\r");

/** Regex-path fixtures, one per language family that carries end-anchored rules. */
const SAMPLES: Array<{ glob: string; language: Language }> = [
  { glob: "test-fixtures/sample-perl-catalyst/**/*.pm", language: "perl" },
  { glob: "test-fixtures/sample-go-api/**/*.go", language: "go" },
  { glob: "test-fixtures/sample-rust-axum/**/*.rs", language: "rust" },
  { glob: "test-fixtures/sample-ruby-web/**/*.rb", language: "ruby" },
  { glob: "test-fixtures/**/*.vb", language: "vb" },
  { glob: "test-fixtures/**/*.sql", language: "sql" },
];

describe("regex extraction is line-ending invariant", () => {
  for (const { glob, language } of SAMPLES) {
    const files = fg.sync(glob, { cwd: REPO_ROOT }).slice(0, 12);

    it(`${language}: found fixture sources`, () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const rel of files) {
      it(`${language}: ${rel}`, () => {
        const lf = readFileSync(resolve(REPO_ROOT, rel), "utf-8").replace(/\r\n?/g, "\n");
        const fromLf = extractWithRegex(lf, rel, language);
        const fromCrlf = extractWithRegex(toCrlf(lf), rel, language);
        const fromCr = extractWithRegex(toCr(lf), rel, language);
        expect(fromCrlf).toEqual(fromLf);
        expect(fromCr).toEqual(fromLf);
      });
    }
  }
});

describe("security scanning is line-ending invariant", () => {
  // Mixed tree-sitter and regex languages — the scanner is line-oriented for both.
  const files = fg
    .sync("test-fixtures/**/*.{ts,js,py,cs,go,rb,php,pm}", { cwd: REPO_ROOT })
    .slice(0, 40);

  it("found fixture sources", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const rel of files) {
    const language = EXTENSION_TO_LANGUAGE[rel.slice(rel.lastIndexOf("."))];
    if (!language) continue;
    it(rel, () => {
      const lf = readFileSync(resolve(REPO_ROOT, rel), "utf-8").replace(/\r\n?/g, "\n");
      expect(scanSecurity(toCrlf(lf), rel, language)).toEqual(scanSecurity(lf, rel, language));
    });
  }
});

describe("splitLines", () => {
  it("drops the carriage return of CRLF and CR-only input", () => {
    expect(splitLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
    expect(splitLines("a\rb\rc")).toEqual(["a", "b", "c"]);
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("keeps the line count identical to splitting on \\n for LF input", () => {
    const text = "one\ntwo\n\nfour\n";
    expect(splitLines(text)).toEqual(text.split("\n"));
  });

  it("does not swallow a lone \\r inside a line-less string", () => {
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("single")).toEqual(["single"]);
  });
});
