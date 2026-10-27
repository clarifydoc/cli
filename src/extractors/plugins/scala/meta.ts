import { C_STYLE_DOCS } from "../../shared/doc-comment-specs.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { scalaSpec } from "./index.js";
import { scalaPackages } from "./packages.js";
import { scalaManifest } from "./manifest.js";
import { scalaRequestSchema } from "./request-schema.js";
import { scalaReachability } from "./reachability.js";

const SCALA_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Int", "Long", "Short", "Byte", "Float", "Double", "Boolean", "Char",
  "List", "Seq", "Vector", "Array", "Map", "Set", "Option", "Some", "None",
  "Either", "Left", "Right", "Try", "Success", "Failure",
  "Future", "Promise",
  "String", "AnyVal", "AnyRef", "Nothing", "Unit",
]);

/**
 * A Scala declaration opening a line — what every Scala script has and a
 * SuperCollider `.sc` class file (`MyClass : Object { *new { … } }`) or
 * session file (`SynthDef(\x, { … }).add;`) does not.
 */
const SCALA_DECLARATION_RE = /^[ \t]*(?:import|def|val|object|class|trait|enum|given|package|case\s+class|@main|\/\/>\s*using)\b/m;

export const scalaMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: scalaReachability,
  ...scalaManifest,
  docComments: C_STYLE_DOCS,
  preprocess: (rawSource, relativePath) =>
    relativePath.toLowerCase().endsWith(".sc") && !SCALA_DECLARATION_RE.test(rawSource)
      ? { skip: "not a Scala script (no Scala declaration — SuperCollider?)" }
      : null,
  regexSpec: scalaSpec,
  // Functions and calls read by tree-sitter-scala while the `tree-sitter:scala` feature is on (tree-sitter.ts).
  treeSitter: { grammar: "scala", extensions: [".scala", ".sc"], load: () => import("./tree-sitter.js").then((m) => m.loadScalaReader()) },
  knownPackages: scalaPackages,
  builtinTypes: SCALA_BUILTINS,
  requestSchema: scalaRequestSchema,
};
