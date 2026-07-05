import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Hackage (Haskell / cabal / stack) package recognition. */
export const hackagePackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["yesod", "yesod-core"], category: "framework", framework: { id: "yesod", name: "Yesod" } },
  { names: ["servant", "servant-server"], category: "framework", framework: { id: "servant", name: "Servant" } },
  { names: ["scotty"], category: "framework", framework: { id: "scotty", name: "Scotty" } },
  { names: ["spock"], category: "framework", framework: { id: "spock", name: "Spock" } },
  { names: ["wai", "warp"], category: "framework" },
  // ── ORM / database ──
  { names: ["persistent", "persistent-postgresql", "esqueleto", "beam-core", "opaleye"], category: "orm" },
  { names: ["postgresql-simple", "mysql-simple", "sqlite-simple", "hedis"], category: "database" },
  // ── HTTP ──
  { names: ["http-client", "http-conduit", "req", "wreq"], category: "http" },
  // ── Serialization ──
  { names: ["aeson", "yaml", "cassava"], category: "serialization" },
  // ── Logging ──
  { names: ["katip", "fast-logger", "monad-logger"], category: "logging" },
  // ── Testing ──
  { names: ["hspec", "tasty", "QuickCheck", "hedgehog"], category: "testing" },
  // ── Utility ──
  { names: ["text", "bytestring", "containers", "lens", "mtl", "vector", "unordered-containers"], category: "util" },
];
