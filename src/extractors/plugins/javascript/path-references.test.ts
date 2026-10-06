import { describe, it, expect } from "vitest";
import { extractPathReferences } from "./path-references.js";

describe("JS path references (strings the toolchain loads as modules)", () => {
  it("captures glob imports and require.context as globs", () => {
    const src = `
      const pages = import.meta.glob("./pages/**/*.vue");
      const eager = import.meta.glob<{ default: unknown }>(["../widgets/*.ts", "!../widgets/skip.ts"], { eager: true });
      const ctx = require.context("./modules", false, /\\.js$/);
      const deep = require.context('./store/');
    `;
    expect(extractPathReferences(src)).toEqual([
      "./pages/**/*.vue", "../widgets/*.ts", "./modules/*", "./store/**/*",
    ]);
  });

  it("captures script paths named as data, but not import or require sources", () => {
    const src = `
      import { a } from "./a.js";
      export * from "./b.ts";
      const lazy = () => import("./c.tsx");
      const cjs = require('./d.js');
      const w = new Worker(new URL("./worker.ts", import.meta.url));
      fork(path.join(__dirname, "child.js"));
      module.exports = { setupFiles: ["<rootDir>/jest.setup.ts"], entry: './src/index.js' };
      const notAPath = "use the ./a.js helper";
      const glob = "src/**/*.ts";
      const cdn = "https://cdn.example.com/lib.js";
    `;
    expect(extractPathReferences(src)).toEqual([
      "./worker.ts", "child.js", "<rootDir>/jest.setup.ts", "./src/index.js",
    ]);
  });
});
