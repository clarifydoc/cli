import type {
  FileAnalysis,
  ExtractorWarning,
  Language,
  FunctionInfo,
  ClassInfo,
  CallInfo,
  RouteInfo,
  Confidence,
} from "../types/analysis.js";
import { EXTENSION_TO_LANGUAGE } from "../extractors/registry.js";

// Derived from the plugin registry so it can never drift from the actual
// language set again (a hand-maintained list here was missing cpp/c/objc/…,
// stamping thousands of bogus "unknown language" warnings on C++ scans).
const VALID_LANGUAGES: ReadonlySet<Language> = new Set<Language>(
  Object.values(EXTENSION_TO_LANGUAGE),
);

const VALID_CALL_KINDS: ReadonlySet<CallInfo["kind"]> = new Set([
  "internal", "cross-file", "api-call", "database",
]);

const VALID_ROUTE_KINDS: ReadonlySet<RouteInfo["kind"]> = new Set([
  "frontend", "api",
]);

const VALID_CONFIDENCES: ReadonlySet<Confidence> = new Set<Confidence>([
  "EXTRACTED", "INFERRED", "AMBIGUOUS",
]);

/**
 * Validate a FileAnalysis against the expected schema.
 *
 * Returns a list of warnings — never throws. An empty list means the analysis
 * is structurally sound. Callers attach warnings to `FileAnalysis.extractorWarnings`
 * so downstream consumers can flag suspicious extractor output without breaking
 * the pipeline.
 *
 * Modeled after graphify-7's validate.py: cheap, dependency-free, collects all
 * issues rather than failing on the first.
 */
export function validateFileAnalysis(a: FileAnalysis): ExtractorWarning[] {
  const warnings: ExtractorWarning[] = [];

  if (!a.filePath) {
    warnings.push({ field: "filePath", message: "missing or empty" });
  }
  if (!VALID_LANGUAGES.has(a.language)) {
    warnings.push({
      field: "language",
      message: `unknown language '${a.language}' — not in supported set`,
    });
  }

  a.imports.forEach((imp, i) => {
    if (typeof imp.line !== "number" || imp.line < 1) {
      warnings.push({
        field: `imports[${i}].line`,
        message: `line must be >= 1, got ${imp.line}`,
      });
    }
    if (!imp.source) {
      warnings.push({
        field: `imports[${i}].source`,
        message: "empty import source",
      });
    }
  });

  a.functions.forEach((fn, i) => validateFunction(fn, `functions[${i}]`, warnings));

  a.classes.forEach((cls, i) => {
    validateClass(cls, `classes[${i}]`, warnings);
  });

  a.routes.forEach((route, i) => {
    if (!VALID_ROUTE_KINDS.has(route.kind)) {
      warnings.push({
        field: `routes[${i}].kind`,
        message: `invalid kind '${route.kind}' — must be 'frontend' or 'api'`,
      });
    }
    if (typeof route.line !== "number" || route.line < 1) {
      warnings.push({
        field: `routes[${i}].line`,
        message: `line must be >= 1, got ${route.line}`,
      });
    }
    route.calls.forEach((call, j) =>
      validateCall(call, `routes[${i}].calls[${j}]`, warnings),
    );
  });

  return warnings;
}

/**
 * Check a function's line range and recurse into its calls, appending a
 * warning per violation (never throwing).
 */
function validateFunction(fn: FunctionInfo, path: string, warnings: ExtractorWarning[]): void {
  if (typeof fn.line !== "number" || fn.line < 1) {
    warnings.push({ field: `${path}.line`, message: `line must be >= 1, got ${fn.line}` });
  }
  if (typeof fn.endLine !== "number" || fn.endLine < fn.line) {
    warnings.push({
      field: `${path}.endLine`,
      message: `endLine (${fn.endLine}) must be >= line (${fn.line})`,
    });
  }
  fn.calls.forEach((call, j) =>
    validateCall(call, `${path}.calls[${j}]`, warnings),
  );
}

/** Check a class's line range and recurse into its methods. */
function validateClass(cls: ClassInfo, path: string, warnings: ExtractorWarning[]): void {
  if (typeof cls.line !== "number" || cls.line < 1) {
    warnings.push({ field: `${path}.line`, message: `line must be >= 1, got ${cls.line}` });
  }
  if (typeof cls.endLine !== "number" || cls.endLine < cls.line) {
    warnings.push({
      field: `${path}.endLine`,
      message: `endLine (${cls.endLine}) must be >= line (${cls.line})`,
    });
  }
  cls.methods.forEach((method, j) =>
    validateFunction(method, `${path}.methods[${j}]`, warnings),
  );
}

/** Check a call's `kind` is one of the known values and its line is positive. */
function validateCall(call: CallInfo, path: string, warnings: ExtractorWarning[]): void {
  if (!VALID_CALL_KINDS.has(call.kind)) {
    warnings.push({
      field: `${path}.kind`,
      message: `invalid kind '${call.kind}' — must be one of ${[...VALID_CALL_KINDS].join(", ")}`,
    });
  }
  if (typeof call.line !== "number" || call.line < 1) {
    warnings.push({
      field: `${path}.line`,
      message: `line must be >= 1, got ${call.line}`,
    });
  }
  if (call.confidence !== undefined && !VALID_CONFIDENCES.has(call.confidence)) {
    warnings.push({
      field: `${path}.confidence`,
      message: `invalid confidence '${call.confidence}' — must be EXTRACTED, INFERRED, or AMBIGUOUS`,
    });
  }
}
