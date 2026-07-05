import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Erlang (rebar3 / Hex) package recognition. Classified by package name. */
export const erlangPackages: readonly KnownPackageRule[] = [
  { names: ["cowboy", "elli"], category: "framework", framework: { id: "cowboy", name: "Cowboy" } },
  { names: ["ranch", "gun"], category: "framework" },
  { names: ["jsx", "jiffy", "jsone"], category: "serialization" },
  { names: ["hackney", "ibrowse"], category: "http" },
  { names: ["lager"], category: "logging" },
  { names: ["epgsql", "eredis", "mnesia"], category: "database" },
  { names: ["eunit", "common_test", "proper", "meck"], category: "testing" },
];
