import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { perlSpec } from "./index.js";
import { cpanPackages } from "./packages.js";

export const perlMeta: LanguagePluginMeta = {
  language: "perl",
  parsing: "regex",
  extensions: perlSpec.extensions,
  regexSpec: perlSpec,
  knownPackages: cpanPackages,
  // Perl test scripts use the `.t` extension (run by `prove`/Test::More).
  testFilePatterns: [/\.t$/],
  builtinTypes: new Set(COMMON_PRIMITIVES),
};
