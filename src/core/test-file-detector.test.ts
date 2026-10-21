import { describe, it, expect } from "vitest";
import { isTestFile } from "./test-file-detector.js";

/**
 * Guards the test-file detector that keeps unit/integration/e2e specs out of
 * route extraction. The regression that motivated it: Cypress `*_spec.js`
 * files under `cypress/` were being mined for `cy.get('selector')` calls and
 * reported as inbound GET routes.
 */

describe("isTestFile — generic (language-agnostic) conventions", () => {
  it.each([
    "src/__tests__/foo.ts",
    "src/__mocks__/foo.ts",
    "test/helpers.js",
    "tests/helpers.js",
    "spec/models/player.rb",
    "specs/player.rb",
    "frontend/cypress/integration/login.js",
    "e2e/checkout.ts",
    "src/players.test.ts",
    "src/players.spec.js",
  ])("flags %s", (p) => {
    expect(isTestFile(p)).toBe(true);
  });

  it("matches Windows-style backslash paths", () => {
    expect(isTestFile("dsps-web\\cypress\\integration\\adhoc\\foo_spec.js")).toBe(true);
  });

  it.each([
    "src/routes/players.ts",
    "src/latest/index.ts", // "latest" must not look like "test"
    "src/contest/page.ts", // "contest" must not look like "test"
    "src/test-utils/render.ts", // helper dir, not a `test/` segment
    "src/integration/payment-gateway.ts", // real code, not under cypress/e2e
    "app/controllers/players_controller.rb",
  ])("does not flag %s", (p) => {
    expect(isTestFile(p)).toBe(false);
  });
});

describe("isTestFile — the original Cypress regression", () => {
  const cypressSpec =
    "dsps-web/cypress/integration/adhoc/createTrainingCaseForSupportPerson_spec.js";

  it("flags the Cypress spec for JavaScript", () => {
    expect(isTestFile(cypressSpec, "javascript")).toBe(true);
  });

  it("flags it even without a language (matched by cypress/ + _spec generics)", () => {
    expect(isTestFile(cypressSpec)).toBe(true);
  });
});

describe("isTestFile — per-language filename conventions", () => {
  it.each([
    ["main_test.go", "go"],
    ["handlers/server_test.go", "go"],
    ["tests_test.go", "go"],
    ["pkg/foo.cy.ts", "typescript"],
    ["src/login-spec.tsx", "typescript"],
    ["src/login_spec.js", "javascript"],
    ["api/test_views.py", "python"],
    ["api/views_test.py", "python"],
    ["api/conftest.py", "python"],
    ["src/main/PlayerServiceTest.java", "java"],
    ["src/main/PlayerServiceIT.java", "java"],
    ["src/main/PlayerServiceTest.kt", "kotlin"],
    ["Controllers/PlayersControllerTests.cs", "csharp"],
    ["app/models/player_spec.rb", "ruby"],
    ["app/models/player_test.rb", "ruby"],
    ["src/PlayerControllerTest.php", "php"],
    ["t/basic.t", "perl"],
  ] as const)("flags %s for %s", (p, lang) => {
    expect(isTestFile(p, lang)).toBe(true);
  });

  it.each([
    ["main.go", "go"],
    ["src/views.py", "python"], // "test_" only matches as a filename prefix
    ["src/PlayerService.java", "java"],
    ["Controllers/PlayersController.cs", "csharp"],
    ["app/models/player.rb", "ruby"],
    ["src/PlayerController.php", "php"],
  ] as const)("does not flag %s for %s", (p, lang) => {
    expect(isTestFile(p, lang)).toBe(false);
  });

  it("does not apply Go's _test.go pattern to a TypeScript file", () => {
    // A language's patterns only apply when that language is passed.
    expect(isTestFile("foo_test.go", "typescript")).toBe(false);
  });
});
