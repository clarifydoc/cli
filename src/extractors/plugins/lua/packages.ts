import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** LuaRocks package recognition. Classified by rock name. */
export const luaPackages: readonly KnownPackageRule[] = [
  { names: ["lapis"], category: "framework", framework: { id: "lapis", name: "Lapis" } },
  { names: ["openresty", "lua-resty-core"], category: "framework" },
  { names: ["luasocket", "lua-http", "http"], category: "http" },
  { names: ["busted", "luaunit"], category: "testing" },
  { names: ["penlight", "luafilesystem", "lpeg", "inspect"], category: "util" },
  { names: ["lua-cjson", "dkjson"], category: "serialization" },
  { names: ["luasql", "lsqlite3"], category: "database" },
];
