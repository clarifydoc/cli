import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { clojureSpec } from "./index.js";
import { clojarsPackages } from "./packages.js";
import { clojureManifest } from "./manifest.js";
import { clojureRequestSchema } from "./request-schema.js";
import { clojureReachability } from "./reachability.js";

export const clojureMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: clojureReachability,
  ...clojureManifest,
  regexSpec: clojureSpec,
  builtinTypes: new Set<string>([...COMMON_PRIMITIVES]),
  knownPackages: clojarsPackages,
  apiCallRoots: ["clj-http.client", "org.httpkit.client"],
  requestSchema: clojureRequestSchema,
};
