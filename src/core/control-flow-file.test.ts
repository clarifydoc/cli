import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "path";
import { ensureLanguagesLoaded } from "../extractors/registry.js";
import { controlFlowForFile, ControlFlowUnavailableError } from "./control-flow-file.js";

const FIXTURES = resolve(__dirname, "../../test-fixtures");

beforeAll(async () => {
  // `.vue` maps to the typescript plugin; the SFC is reached through its
  // preprocess hook, not through a language of its own.
  await ensureLanguagesLoaded(["typescript", "csharp", "go"]);
});

describe("controlFlowForFile", () => {
  it("lists every function of a file when nothing is selected", async () => {
    const result = await controlFlowForFile({
      filePath: resolve(FIXTURES, "sample-backend/services/userService.ts"),
    });
    expect(result.available.length).toBeGreaterThan(0);
    for (const fn of result.available) {
      expect(fn.complexity).toBeGreaterThanOrEqual(1);
      expect(fn.endLine).toBeGreaterThanOrEqual(fn.line);
    }
  });

  it("selects by the bare method name as well as Class.method", async () => {
    const filePath = resolve(FIXTURES, "sample-backend/services/userService.ts");
    const all = await controlFlowForFile({ filePath });
    const qualified = all.available.find((fn) => fn.functionName.includes("."));
    if (!qualified) return; // the fixture has no methods; nothing to assert

    const bare = qualified.functionName.slice(qualified.functionName.indexOf(".") + 1);
    const byBare = await controlFlowForFile({ filePath, functionName: bare });
    expect(byBare.cfgs.some((cfg) => cfg.functionName === qualified.functionName)).toBe(true);
  });

  it("trusts a stale line over losing the function the caller named", async () => {
    // A CodeLens carries the name and the line from the same stored analysis.
    // Edit above the function and the line moves while the name stays right,
    // so a name that matches must win over a line that no longer does.
    const filePath = resolve(FIXTURES, "sample-backend/services/userService.ts");
    const all = await controlFlowForFile({ filePath });
    const target = all.available[0]!;

    const stale = await controlFlowForFile({
      filePath,
      functionName: target.functionName,
      line: target.line + 5000,
    });
    expect(stale.cfgs.map((cfg) => cfg.functionName)).toContain(target.functionName);
  });

  it("reads a Vue SFC through its script block, keeping source line numbers", async () => {
    // Without the preprocess hook this parses the template as TypeScript and
    // draws a graph of the wreckage.
    const result = await controlFlowForFile({
      filePath: resolve(FIXTURES, "sample-react/Dashboard.vue"),
      functionName: "handleUpdate",
    });
    const cfg = result.cfgs[0];
    expect(cfg?.functionName).toBe("handleUpdate");
    // The fixture declares it on line 34; a graph built from the stripped
    // script block alone would report a line near the top of the file.
    expect(cfg!.line).toBe(34);
  });

  it("says so rather than guessing when a language has no control-flow tables", async () => {
    // Clojure's control flow is forms (`(if …)`, `(cond …)`), not lines: neither tier reads it.
    await expect(
      controlFlowForFile({ filePath: resolve(FIXTURES, "sample-clojure-app/src/myapp/db.clj") }),
    ).rejects.toBeInstanceOf(ControlFlowUnavailableError);
  });

  it("says so rather than guessing for an unknown extension", async () => {
    await expect(
      controlFlowForFile({ filePath: resolve(FIXTURES, "sample-backend/package.json") }),
    ).rejects.toBeInstanceOf(ControlFlowUnavailableError);
  });
});

describe("controlFlowForFile with the text given", () => {
  it("draws the text it is given, not the file on disk", async () => {
    // An unsaved edit: one more branch than the saved userService.ts has.
    const filePath = resolve(FIXTURES, "sample-backend/services/userService.ts");
    const source = [
      "export function pick(a: number, b: number): number {",
      "  if (a > b) return a;",
      "  if (a < b) return b;",
      "  return 0;",
      "}",
    ].join("\n");
    const result = await controlFlowForFile({ filePath, source, functionName: "pick" });
    expect(result.cfgs.map((c) => c.functionName)).toEqual(["pick"]);
    expect(result.available.map((f) => f.functionName)).toEqual(["pick"]);
    expect(result.available[0]!.complexity).toBe(3);
  });

  it("reads the text for the regex tier too", async () => {
    const filePath = resolve(FIXTURES, "sample-go-api/main.go");
    const source = "package main\n\nfunc twice(n int) int {\n\tif n > 0 {\n\t\treturn n * 2\n\t}\n\treturn 0\n}\n";
    const result = await controlFlowForFile({ filePath, source });
    expect(result.available.map((f) => f.functionName)).toEqual(["twice"]);
  });
});
