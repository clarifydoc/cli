import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasGemfileDep } from "../shared/project-info-queries.js";

/** Ruby framework rules — ORMs via Gemfile (Rails itself implies Active Record). */
export const rubyFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "active-record",
    name: "Active Record",
    check: (info) => hasGemfileDep(info, "activerecord") || hasGemfileDep(info, "rails"),
    detectedVia: "Gemfile dependency",
  },
  {
    id: "sequel",
    name: "Sequel",
    check: (info) => hasGemfileDep(info, "sequel"),
    detectedVia: "Gemfile dependency",
  },
];
