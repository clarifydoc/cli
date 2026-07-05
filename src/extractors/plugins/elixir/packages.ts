import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Hex (Elixir) package recognition. Classified by package (snake_case) name. */
export const hexPackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["phoenix"], category: "framework", framework: { id: "phoenix", name: "Phoenix" } },
  { names: ["phoenix_live_view"], category: "frontend", framework: { id: "phoenix_live_view", name: "Phoenix LiveView" } },
  { names: ["plug", "plug_cowboy", "bandit"], category: "framework" },
  { names: ["absinthe", "absinthe_plug"], category: "graphql", framework: { id: "absinthe", name: "Absinthe" } },
  // ── ORM / data ──
  { names: ["ecto", "ecto_sql"], category: "orm", framework: { id: "ecto", name: "Ecto" } },
  { names: ["postgrex", "myxql", "redix", "tds"], category: "database" },
  // ── HTTP ──
  { names: ["tesla", "httpoison", "finch", "req", "mint", "hackney"], category: "http" },
  // ── Messaging / background jobs ──
  { names: ["broadway", "oban", "gen_stage", "kafka_ex"], category: "messaging" },
  // ── Serialization ──
  { names: ["jason", "poison"], category: "serialization" },
  // ── Logging / telemetry ──
  { names: ["telemetry", "telemetry_metrics", "logger_json"], category: "logging" },
  // ── Auth ──
  { names: ["guardian", "comeonin", "bcrypt_elixir", "argon2_elixir", "pow"], category: "auth" },
  // ── Lint / docs ──
  { names: ["credo", "dialyxir", "ex_doc", "sobelow"], category: "lint" },
  // ── Testing ──
  { names: ["ex_machina", "mox", "stream_data", "wallaby"], category: "testing" },
];
