import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { splitLines } from "../../shared/source-lines.js";
import { fortranSpec, fortranImports } from "./index.js";
import { fortranManifest } from "./manifest.js";
import { fortranReachability } from "./reachability.js";
import { isFixedForm, normalizeFortran } from "./source.js";

const FORTRAN_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "integer", "logical", "complex", "character", "byte", "double precision", "double complex", "c_int", "c_double",
  "c_float", "c_char", "c_ptr", "c_funptr", "c_bool", "c_size_t", "c_long",
]);

export const fortranMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: fortranReachability,
  ...fortranManifest,
  regexSpec: fortranSpec,
  builtinTypes: FORTRAN_BUILTINS,
  // One statement per line, comments gone (see source.ts); imports are read
  // afterwards — `#include` lines from the raw source.
  preprocess(rawSource, relativePath) {
    const raw = splitLines(rawSource);
    const sourceText = normalizeFortran(raw, isFixedForm(relativePath, raw)).join("\n");
    return {
      sourceText,
      language: "fortran",
      postExtract(analysis) {
        analysis.imports = fortranImports(splitLines(sourceText), raw);
      },
    };
  },
};
