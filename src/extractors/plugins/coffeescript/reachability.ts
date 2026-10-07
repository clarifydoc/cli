import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * CoffeeScript dead-code model: `require './x'` / `import … from './x'` name
 * files (JavaScript's resolution, `index.coffee` for a directory). A program
 * starts at a conventional entry (`index` / `app` / `server` / `main` /
 * `cli`); `package.json` and the `Cakefile` name more; Hubot loads every
 * `scripts/` file itself (passive). A file named anywhere reachable stays
 * alive — compiled projects reach sources through build files this pass
 * does not read, and every finding is an accusation.
 */
export const coffeeReachability = conventionReachability({
  extensions: [".coffee", ".litcoffee"],
  importPath: (source) => (/^\.{1,2}\//.test(source) ? source : null),
  indexFiles: ["index.coffee"],
  names: { stem: true },
  entryFiles: [[/(?:^|\/)(?:index|app|server|main|cli)\.(?:lit)?coffee$/, "conventional entry"]],
  passiveFiles: [
    [/(?:^|\/)scripts\//, "Hubot / build script"],
    [/(?:^|\/)(?:test|spec)s?\//, "test"],
  ],
  configFiles: /(?:^|\/)(?:package\.json|Cakefile)$/,
});
