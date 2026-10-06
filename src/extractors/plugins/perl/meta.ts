import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { extendRegexControlFlow } from "../../shared/control-flow-defaults.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { perlSpec } from "./index.js";
import { cpanPackages } from "./packages.js";
import { perlManifest } from "./manifest.js";
import { perlRequestSchema } from "./request-schema.js";
import { perlReachability } from "./reachability.js";

export const perlMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: perlReachability,
  // Perl: `unless`/`until` are the negated forms, `foreach` is a loop, and `#`
  // is the comment.
  regexControlFlow: extendRegexControlFlow([], {
    lineComments: ["#"],
    blockComment: ["", ""],
    quotes: ['"', "'"],
  }),
  ...perlManifest,
  regexSpec: perlSpec,
  knownPackages: cpanPackages,
  builtinTypes: new Set(COMMON_PRIMITIVES),
  requestSchema: perlRequestSchema,
};
