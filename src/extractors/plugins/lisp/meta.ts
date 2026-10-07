import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { deriveExportsFromFnClasses } from "../shared/regex-base.js";
import { tryReadForms } from "../shared/sexpr.js";
import { lispSpec } from "./index.js";
import { commonLispManifest, racketManifest, schemeManifest } from "./manifest.js";
import { readLispFile, type LispDialect } from "./forms.js";
import { extractLispDataSources, extractLispRoutes } from "./web.js";
import { lispPackages } from "./packages.js";
import { lispReachability } from "./reachability.js";

/**
 * Read the whole file as forms and fill the analysis from them. A file the
 * reader cannot balance (a reader macro it does not know) keeps the empty
 * analysis rather than a wrong one.
 */
function fromForms(analysis: FileAnalysis, raw: string, dialect: LispDialect, isTest: boolean): void {
  const forms = tryReadForms(raw, "lisp");
  if (!forms) return;
  const file = readLispFile(forms, dialect);
  analysis.functions = file.setup.length > 0
    ? [{ name: "<setup>", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: file.setup, line: 1, endLine: 1 }, ...file.functions]
    : file.functions;
  analysis.classes = file.classes;
  analysis.imports = file.imports;
  analysis.exports = file.exports.length > 0 ? file.exports : deriveExportsFromFnClasses(file.functions, file.classes);
  analysis.routes = isTest ? [] : extractLispRoutes(forms, dialect);
  analysis.dataSources = extractLispDataSources(forms);
}

function lispMeta(manifest: typeof racketManifest, dialect: LispDialect): LanguagePluginMeta {
  return {
    reachability: lispReachability,
    ...manifest,
    preprocess(rawSource, filePath) {
      const isTest = (manifest.testFilePatterns ?? []).some((p) => p.test(filePath));
      return { sourceText: rawSource, language: manifest.language, postExtract: (analysis, raw) => fromForms(analysis, raw, dialect, isTest) };
    },
    regexSpec: lispSpec(manifest.language, [...manifest.extensions]),
    knownPackages: lispPackages,
    builtinTypes: new Set([...COMMON_PRIMITIVES, "integer", "string", "number", "boolean", "symbol", "list", "vector", "hash-table", "t"]),
  };
}

export const racketMeta = lispMeta(racketManifest, "racket");
export const schemeMeta = lispMeta(schemeManifest, "scheme");
export const commonLispMeta = lispMeta(commonLispManifest, "commonlisp");
