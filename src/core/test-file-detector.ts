import type { Language } from "../types/analysis.js";
import { testFilePatternsFor, testSubjectAffixesFor } from "../extractors/registry.js";

/**
 * Detects test files — unit, integration, and e2e specs — from their path.
 *
 * Two layers:
 *  - GENERIC patterns below cover cross-language conventions (test/spec
 *    directories, `*.test.*` / `*.spec.*` suffixes, Jest `__tests__/`,
 *    `cypress/`, `e2e/`). These apply to every language.
 *  - Per-language patterns come from each plugin's `meta.testFilePatterns`
 *    (e.g. Go `_test.go`, JS `*_spec.js` / `*.cy.ts`, Python `test_*.py`).
 *
 * Test files are excluded from route extraction: a Cypress `cy.get('button')`
 * or a Jest `request(app).get('/x')` must not surface as an inbound endpoint.
 */

/** Cross-language test conventions, matched against `/`- or `\`-separated paths. */
const GENERIC_TEST_PATTERNS: readonly RegExp[] = [
  // Jest layout: __tests__/ and __mocks__/ directories.
  /(^|[\\/])__tests__[\\/]/,
  /(^|[\\/])__mocks__[\\/]/,
  // A `test/`, `tests/`, `spec/`, or `specs/` directory segment.
  /(^|[\\/])tests?[\\/]/i,
  /(^|[\\/])specs?[\\/]/i,
  // Browser/e2e test harness directories.
  /(^|[\\/])cypress[\\/]/i,
  /(^|[\\/])e2e[\\/]/i,
  // `foo.test.ts`, `foo.spec.js` — the near-universal suffix convention.
  /\.(test|spec)\.[^.\\/]+$/i,
];

/** Per-language combined pattern lists, cached (generic ++ plugin-contributed). */
const combinedCache = new Map<Language | "<none>", readonly RegExp[]>();

/** The generic test-file patterns plus the language's own, merged once per language and cached. */
function patternsFor(language?: Language): readonly RegExp[] {
  const key = language ?? "<none>";
  let combined = combinedCache.get(key);
  if (!combined) {
    combined = language
      ? [...GENERIC_TEST_PATTERNS, ...testFilePatternsFor(language)]
      : GENERIC_TEST_PATTERNS;
    combinedCache.set(key, combined);
  }
  return combined;
}

/**
 * True if `filePath` is a test file. Pass `language` to also apply that
 * language's plugin-declared patterns; omit it for a path-only (generic) check.
 */
export function isTestFile(filePath: string, language?: Language): boolean {
  for (const re of patternsFor(language)) {
    if (re.test(filePath)) return true;
  }
  return false;
}

/**
 * The stem of the file a test file tests, as its name says (`club_test.go`, `test_club.py`,
 * `ClubTest.java`, `club_spec.rb`, `club.test.ts` → `club` / `Club`): the cross-language
 * `.test` / `.spec`, then the language's own affixes (`testSubjectAffixes`), each stripped once,
 * longest first. A test file whose name carries no affix (`tests/club.rs`) names its subject by
 * its own stem. Null for a file that is no test file.
 */
export function testSubjectStem(filePath: string, language?: Language): string | null {
  if (!isTestFile(filePath, language)) return null;
  const base = filePath.slice(filePath.replace(/\\/g, "/").lastIndexOf("/") + 1);
  let stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  stem = stem.replace(/\.(?:test|spec)$/i, "");
  if (language) {
    const { prefixes, suffixes } = testSubjectAffixesFor(language);
    const prefix = [...prefixes].sort((a, b) => b.length - a.length).find((p) => stem.startsWith(p) && stem.length > p.length);
    if (prefix) stem = stem.slice(prefix.length);
    const suffix = [...suffixes].sort((a, b) => b.length - a.length).find((x) => stem.endsWith(x) && stem.length > x.length);
    if (suffix) stem = stem.slice(0, -suffix.length);
  }
  return stem || null;
}
