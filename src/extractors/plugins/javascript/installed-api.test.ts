import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { npmInstalledApi } from "./installed-api.js";

let root = "";
const put = async (path: string, text: string) => {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "clarifydoc-installed-api-"));
  // Typed through the exports map, re-exporting a second file.
  await put("node_modules/@league/table/package.json", JSON.stringify({ name: "@league/table", version: "4.2.0", exports: { ".": { import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" } } } }));
  await put("node_modules/@league/table/dist/index.d.mts", [
    'export * from "./standings.js";',
    "/** Points for a result. */",
    "export declare function points(result: \"win\" | \"draw\" | \"loss\"): number;",
    "export declare const MAX_CLUBS: number;",
    "export interface Club {",
    "  name: string;",
    "  points: number;",
    "}",
    "export { points as score, type Club as Team };",
    "export default class League {",
    "  constructor(name: string);",
    "}",
  ].join("\n"));
  await put("node_modules/@league/table/dist/standings.d.ts", "export declare class Standings {\n  sorted(): string[];\n}\nexport type Position = number;\n");
  // No types of its own: the @types package answers.
  await put("node_modules/car-utils/package.json", JSON.stringify({ name: "car-utils", version: "1.0.3", main: "lib/index.js" }));
  await put("node_modules/car-utils/lib/index.js", "exports.speed = function () {};\n");
  await put("node_modules/@types/car-utils/package.json", JSON.stringify({ name: "@types/car-utils", version: "1.0.1", types: "index.d.ts" }));
  await put("node_modules/@types/car-utils/index.d.ts", "export function speed(kmh: number): string;\n");
  // Plain CommonJS, nothing typed.
  await put("node_modules/garage-tools/package.json", JSON.stringify({ name: "garage-tools", version: "0.9.0" }));
  await put("node_modules/garage-tools/index.js", "module.exports = { lift, wash };\nexports.park = () => {};\n");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("an installed npm package's API", () => {
  it("reads the declarations the exports map names, following export * into the package's own files", async () => {
    const api = (await npmInstalledApi([root], "@league/table"))!;
    expect(api.version).toBe("4.2.0");
    expect(api.source).toMatch(/dist\/index\.d\.mts$/);
    expect(api.exports.map((e) => `${e.kind} ${e.name}`)).toEqual([
      "class Standings", "type Position",
      "function points", "const MAX_CLUBS", "interface Club", "re-export score", "type Team", "class default",
    ]);
    expect(api.exports.find((e) => e.name === "points")!.signature).toBe('export declare function points(result: "win" | "draw" | "loss"): number');
  });

  it("gives one export's declaration with its doc comment", async () => {
    const api = (await npmInstalledApi([root], "@league/table", "Club"))!;
    expect(api.declaration!.text).toBe("export interface Club {\n  name: string;\n  points: number;\n}");
    const fn = (await npmInstalledApi([root], "@league/table", "points"))!;
    expect(fn.declaration!.text).toBe('/** Points for a result. */\nexport declare function points(result: "win" | "draw" | "loss"): number;');
    // A re-export answers with what it re-exports, wherever that is declared.
    const alias = (await npmInstalledApi([root], "@league/table", "score"))!;
    expect(alias.exports.find((e) => e.name === "score")!.signature).toBe("export { points as score }");
    expect(alias.declaration!.text).toBe(fn.declaration!.text);
    const standings = (await npmInstalledApi([root], "@league/table", "Standings"))!;
    expect(standings.declaration!.file).toMatch(/standings\.d\.ts$/);
  });

  it("falls back to the @types package, then to the entry module's CommonJS exports", async () => {
    const typed = (await npmInstalledApi([root], "car-utils"))!;
    expect(typed.version).toBe("1.0.3");
    expect(typed.exports.map((e) => e.signature)).toEqual(["export function speed(kmh: number): string"]);
    const cjs = (await npmInstalledApi([root], "garage-tools"))!;
    expect(cjs.exports.map((e) => e.name)).toEqual(["lift", "wash", "park"]);
  });

  it("refuses a name that is not a package name, and says null when it is not installed", async () => {
    expect(await npmInstalledApi([root], "../../etc")).toBeNull();
    expect(await npmInstalledApi([root], "transfer-market")).toBeNull();
  });
});
