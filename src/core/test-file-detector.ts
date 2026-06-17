import type { Language } from "../types/analysis.js";
import { testFilePatternsFor } from "../extractors/registry.js";

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
