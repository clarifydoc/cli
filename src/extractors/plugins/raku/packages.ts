import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Raku distribution recognition. */
export const rakuPackages: readonly KnownPackageRule[] = [
  { names: ["Cro::HTTP", "Cro::WebApp", "Cro::Core"], category: "framework", framework: { id: "cro", name: "Cro" } },
  { names: ["Humming-Bird"], category: "framework", framework: { id: "humming-bird", name: "Humming-Bird" } },
  { names: ["DBIish", "Red", "DB::Pg", "DB::SQLite", "DB::MySQL"], category: "database" },
  { names: ["HTTP::UserAgent", "HTTP::Tiny"], category: "http" },
  { names: ["JSON::Fast", "JSON::Tiny"], category: "serialization" },
  { names: ["Test", "Test::Mock"], category: "testing" },
];
