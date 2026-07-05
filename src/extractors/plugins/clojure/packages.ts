import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Clojure (Clojars / Maven via deps.edn or Leiningen) package recognition. */
export const clojarsPackages: readonly KnownPackageRule[] = [
  // ── Frameworks (web) ──
  { names: ["ring", "ring/ring-core", "ring/ring-jetty-adapter"], category: "framework", framework: { id: "ring", name: "Ring" } },
  { names: ["compojure"], category: "framework", framework: { id: "compojure", name: "Compojure" } },
  { names: ["metosin/reitit", "reitit"], category: "framework", framework: { id: "reitit", name: "Reitit" } },
  { names: ["luminus", "pedestal", "io.pedestal/pedestal.service"], category: "framework" },
  // ── Frontend ──
  { names: ["reagent", "re-frame"], category: "frontend", framework: { id: "re-frame", name: "re-frame" } },
  // ── ORM / database ──
  { names: ["seancorfield/next.jdbc", "com.github.seancorfield/next.jdbc", "org.clojure/java.jdbc", "korma", "honeysql"], category: "orm" },
  { names: ["org.postgresql/postgresql", "com.taoensso/carmine"], category: "database" },
  // ── HTTP ──
  { names: ["clj-http", "http-kit"], category: "http" },
  // ── Serialization ──
  { names: ["cheshire", "org.clojure/data.json", "metosin/muuntaja"], category: "serialization" },
  // ── Logging ──
  { names: ["com.taoensso/timbre", "org.clojure/tools.logging"], category: "logging" },
  // ── Testing ──
  { names: ["midje", "lambdaisland/kaocha", "org.clojure/test.check"], category: "testing" },
];
