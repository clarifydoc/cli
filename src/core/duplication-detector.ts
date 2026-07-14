import type { FileAnalysis, DuplicateGroup } from "../types/analysis.js";
import { isTestFile } from "./test-file-detector.js";
import { vendoredMinoritySet } from "./security-scanner.js";

/** Common/idiomatic function names that are expected to repeat across files */
const IDIOMATIC_NAMES = new Set([
  // Lifecycle
  "constructor", "ngOnInit", "ngOnDestroy", "ngOnChanges", "ngAfterViewInit",
  "componentDidMount", "componentWillUnmount", "componentDidUpdate",
  "shouldComponentUpdate", "getDerivedStateFromProps",
  "mounted", "created", "updated", "destroyed", "beforeCreate", "beforeMount",
  "onMount", "onDestroy", "setup",
  // Handlers
  "handleClick", "handleChange", "handleSubmit", "handleInput",
  "onClick", "onChange", "onSubmit", "onBlur", "onFocus",
  // Test
  "setUp", "tearDown", "setUpClass", "tearDownClass",
  "beforeEach", "afterEach", "beforeAll", "afterAll",
  // Python dunders
  "__init__", "__str__", "__repr__", "__eq__", "__hash__", "__len__",
  "__enter__", "__exit__", "__getattr__", "__setattr__", "__iter__", "__next__",
  // Common utilities
  "render", "toString", "toJSON", "clone", "reset", "validate", "init",
  "get", "set", "update", "delete", "create", "find", "fetch", "save",
  "index", "show", "store", "destroy", "edit",
  // Framework entry points
  "main", "configure", "register", "upgrade", "downgrade",
  "<setup>",
]);

/** Build a structural fingerprint for a function based on its calls */
function buildFingerprint(
  fn: { calls: { name: string; kind: string }[]; params: { name: string }[]; line: number; endLine: number },
): string {
  const lineCount = Math.floor((fn.endLine - fn.line) / 5) * 5; // bucket by 5
  const callCount = fn.calls.length;
  const paramCount = fn.params.length;
  const crossFileCalls = fn.calls.filter((c) => c.kind === "cross-file").length;
  const dbCalls = fn.calls.filter((c) => c.kind === "database").length;
  const apiCalls = fn.calls.filter((c) => c.kind === "api-call").length;

  return `L${lineCount}C${callCount}P${paramCount}X${crossFileCalls}D${dbCalls}A${apiCalls}`;
}

/** Compute similarity between two call lists (Jaccard-like) */
function callSimilarity(
  calls1: { name: string }[],
  calls2: { name: string }[],
): number {
  if (calls1.length === 0 && calls2.length === 0) return 1;
  if (calls1.length === 0 || calls2.length === 0) return 0;

  const set1 = new Set(calls1.map((c) => c.name));
  const set2 = new Set(calls2.map((c) => c.name));

  let intersection = 0;
  for (const name of set1) {
    if (set2.has(name)) intersection++;
  }

  const union = new Set([...set1, ...set2]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Detect duplicate functions across files.
 */
export function detectDuplicates(analyses: FileAnalysis[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  // Test files are full of intentionally repeated scaffolding (mock factories,
  // mount helpers) — not duplication the team should deduplicate. Minified or
  // bundled artifacts are excluded too: a webpack bundle carries compiled
  // COPIES of authored functions, so every source function would pair with
  // its own build output.
  const vendored = vendoredMinoritySet(analyses);
  const authored = analyses.filter(
    (a) => !a.minified && !vendored.has(a.filePath) && !isTestFile(a.filePath, a.language),
  );

  // ── Name-based duplication ──
  const fnByName = new Map<string, { filePath: string; line: number; fn: FileAnalysis["functions"][0] }[]>();

  for (const a of authored) {
    for (const fn of a.functions) {
      if (IDIOMATIC_NAMES.has(fn.name)) continue;
      if (fn.name.length < 3) continue;
      if (fn.name.startsWith("_") && fn.name.endsWith("_")) continue;
      // Skip decorated functions (framework handlers)
      if (fn.decorators.length > 0) continue;
      // A shared name only signals copy-paste when there's a body worth
      // comparing — tiny handlers (submit/logout/onDragStart) repeat by idiom.
      if (fn.endLine - fn.line < 5) continue;
      if (fn.calls.length < 2) continue;

      const existing = fnByName.get(fn.name) ?? [];
      existing.push({ filePath: a.filePath, line: fn.line, fn });
      fnByName.set(fn.name, existing);
    }
  }

  for (const [name, occurrences] of fnByName) {
    // Same name is not duplication — require each occurrence to actually make
    // the same calls as the first before it counts toward the group.
    const anchor = occurrences[0];
    const similar = [anchor, ...occurrences.slice(1).filter(
      (o) => callSimilarity(anchor.fn.calls, o.fn.calls) >= 0.6,
    )];

    const uniqueFiles = new Set(similar.map((o) => o.filePath));
    if (uniqueFiles.size < 3) continue;

    groups.push({
      functionName: name,
      occurrences: similar.map((o) => ({
        filePath: o.filePath,
        line: o.line,
        similarity: Math.round(callSimilarity(anchor.fn.calls, o.fn.calls) * 100),
      })),
      kind: "name-based",
    });
  }

  // ── Structural fingerprint duplication ──
  const fingerprints = new Map<string, { filePath: string; name: string; line: number; fn: FileAnalysis["functions"][0] }[]>();

  for (const a of authored) {
    for (const fn of a.functions) {
      if (fn.name === "<setup>") continue;
      if (fn.endLine - fn.line < 5) continue; // skip very short functions
      if (fn.calls.length < 2) continue; // need some structure to compare

      const fp = buildFingerprint(fn);
      const existing = fingerprints.get(fp) ?? [];
      existing.push({ filePath: a.filePath, name: fn.name, line: fn.line, fn });
      fingerprints.set(fp, existing);
    }
  }

  for (const [_fp, fns] of fingerprints) {
    if (fns.length < 2) continue;

    // Same fingerprint bucket ≠ same code — keep only members whose calls
    // actually overlap with the first one's.
    const similar = [fns[0], ...fns.slice(1).filter(
      (f) => callSimilarity(fns[0].fn.calls, f.fn.calls) > 0.7,
    )];
    if (similar.length < 2) continue;
    const uniqueFiles = new Set(similar.map((f) => f.filePath));
    if (uniqueFiles.size < 2) continue;

    // Avoid duplicating name-based findings
    const names = new Set(similar.map((f) => f.name));
    if (names.size === 1 && groups.some((g) => g.functionName === similar[0].name)) {
      continue;
    }

    groups.push({
      functionName: similar.map((f) => f.name).filter((n, i, a) => a.indexOf(n) === i).join(", "),
      occurrences: similar.map((f) => ({
        filePath: f.filePath,
        line: f.line,
        similarity: Math.round(callSimilarity(fns[0].fn.calls, f.fn.calls) * 100),
      })),
      kind: "structural",
    });
  }

  return groups;
}
