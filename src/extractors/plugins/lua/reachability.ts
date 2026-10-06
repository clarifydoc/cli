import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Lua dead-code model. `require "a.b"` names `a/b.lua` or `a/b/init.lua`;
 * global functions are reached by name. `main.lua`/`conf.lua` start a
 * program (LÖVE and friends); Neovim and Vim load whole runtime directories.
 */
export const luaReachability = conventionReachability({
  extensions: [".lua"],
  importPath: (source) => (/^[\w./-]+$/.test(source) ? source.replace(/\.lua$/, "").replace(/\./g, "/") : null),
  indexFiles: ["init.lua"],
  names: { functions: true, stem: true },
  entryFiles: [[/(?:^|\/)(?:main|conf)\.lua$/, "program entry"]],
  frameworkEntries: { lapis: [[/(?:^|\/)app\.lua$/, "Lapis application"]] },
  passiveFiles: [[/(?:^|\/)(?:plugin|ftplugin|after|colors|syntax|indent|autoload|spec)\//, "loaded by its runtime path"]],
  shebang: /\blua(?:jit)?\b/,
});
