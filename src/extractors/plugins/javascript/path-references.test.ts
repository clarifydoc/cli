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

describe("path references — typed globs and route configs", () => {
  it("reads a glob whose type argument holds an arrow type or a nested generic", () => {
    expect(extractPathReferences("const m = import.meta.glob<{ meta: M; default: () => ReactNode }>('./games/*.tsx', { eager: true });")).toEqual(["./games/*.tsx"]);
    expect(extractPathReferences("const m = import.meta.glob<Record<string, M>>('./a/*.ts');")).toEqual(["./a/*.ts"]);
  });
  it("names a React Router config's route modules relative to the config", () => {
    const src = 'import { index, route, layout } from "@react-router/dev/routes";\nexport default [layout("components/Layout.tsx", [index("pages/Home.tsx"), route("blog/:slug", "pages/Game.tsx", { id: "p" })])];';
    expect(extractPathReferences(src).sort()).toEqual(["./components/Layout.tsx", "./pages/Home.tsx", "./pages/Game.tsx", "components/Layout.tsx", "pages/Home.tsx", "pages/Game.tsx"].sort());
  });
});

describe("path references — templates over same-file constants", () => {
  it("names one script per value of the array a template's hole is mapped over", () => {
    const src = `
      const here = path.dirname(fileURLToPath(import.meta.url));
      const VIEWS = [
        "squad",
        'fixtures', // the match list
      ] as const;
      export default defineConfig({
        build: { rollupOptions: { input: Object.fromEntries(VIEWS.map((view) => [view, path.resolve(here, \`src/views/\${view}/main.tsx\`)])) } },
      });
    `;
    expect(extractPathReferences(src)).toEqual(["src/views/squad/main.tsx", "src/views/fixtures/main.tsx"]);
  });

  it("fills holes from for-of loops and string constants, and skips a hole it has no values for", () => {
    const src = `
      const KIND = "garage";
      const CARS = ["coupe", "estate"];
      for (const car of CARS) entries.push(\`./\${KIND}/\${car}.ts\`);
      const other = \`./pages/\${name}.vue\`;
      const notAPath = \`\${KIND} has \${CARS.length} cars\`;
      const mixed = \`./\${KIND}/\${car.toUpperCase()}.ts\`;
    `;
    expect(extractPathReferences(src)).toEqual(["./garage/coupe.ts", "./garage/estate.ts"]);
  });

  it("does not expand over an array that holds anything but strings", () => {
    const src = `const CLUBS = ["home", other]; CLUBS.map((club) => \`./clubs/\${club}.ts\`);`;
    expect(extractPathReferences(src)).toEqual([]);
  });
});
