import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** RubyGems recognition (Gemfile). Plugin-owned. */
export const rubygemsPackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["rails"], category: "framework", framework: { id: "rails", name: "Ruby on Rails" } },
  { names: ["sinatra"], category: "framework", framework: { id: "sinatra", name: "Sinatra" } },
  { names: ["hanami"], category: "framework", framework: { id: "hanami", name: "Hanami" } },
  { names: ["grape"], category: "framework", framework: { id: "grape", name: "Grape" } },
  // ── ORM ──
  { names: ["activerecord", "sequel"], category: "orm" },
  // ── Testing ──
  { names: ["rspec", "minitest", "factory_bot"], category: "testing" },
  // ── Lint ──
  { names: ["rubocop"], category: "lint" },
];
