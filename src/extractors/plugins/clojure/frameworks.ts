import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasCljDep } from "../shared/project-info-queries.js";

/** Clojure web framework rules via project.clj / deps.edn. */
export const clojureFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "ring",
    name: "Ring",
    check: (info) => hasCljDep(info, "ring"),
    detectedVia: "project.clj / deps.edn dependency",
  },
  {
    id: "compojure",
    name: "Compojure",
    check: (info) => hasCljDep(info, "compojure"),
    detectedVia: "project.clj / deps.edn dependency",
  },
  {
    id: "reitit",
    name: "reitit",
    check: (info) => hasCljDep(info, "reitit"),
    detectedVia: "project.clj / deps.edn dependency",
  },
];
