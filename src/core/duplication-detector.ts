import type { FileAnalysis, DuplicateGroup } from "../types/analysis.js";

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

  // ── Name-based duplication ──
  const fnByName = new Map<string, { filePath: string; line: number; fn: FileAnalysis["functions"][0] }[]>();

  for (const a of analyses) {
    for (const fn of a.functions) {
      if (IDIOMATIC_NAMES.has(fn.name)) continue;
      if (fn.name.length < 3) continue;
      if (fn.name.startsWith("_") && fn.name.endsWith("_")) continue;
      // Skip decorated functions (framework handlers)
      if (fn.decorators.length > 0) continue;

      const existing = fnByName.get(fn.name) ?? [];
      existing.push({ filePath: a.filePath, line: fn.line, fn });
      fnByName.set(fn.name, existing);
    }
  }

  for (const [name, occurrences] of fnByName) {
    const uniqueFiles = new Set(occurrences.map((o) => o.filePath));
    if (uniqueFiles.size < 3) continue;

    // Check if functions are actually similar (not just same name)
    const first = occurrences[0].fn;
    const second = occurrences[1].fn;
    const sim = callSimilarity(first.calls, second.calls);

    if (sim > 0.3 || (first.params.length === second.params.length && first.calls.length > 0)) {
      groups.push({
        functionName: name,
        occurrences: occurrences.map((o) => ({
          filePath: o.filePath,
          line: o.line,
          similarity: Math.round(sim * 100),
        })),
        kind: "name-based",
      });
    }
  }

  // ── Structural fingerprint duplication ──
  const fingerprints = new Map<string, { filePath: string; name: string; line: number; fn: FileAnalysis["functions"][0] }[]>();

  for (const a of analyses) {
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
    const uniqueFiles = new Set(fns.map((f) => f.filePath));
    if (uniqueFiles.size < 2) continue;

    // Verify with actual call similarity
    const sim = callSimilarity(fns[0].fn.calls, fns[1].fn.calls);
    if (sim > 0.7) {
      // Avoid duplicating name-based findings
      const names = new Set(fns.map((f) => f.name));
      if (names.size === 1 && groups.some((g) => g.functionName === fns[0].name)) {
        continue;
      }

      groups.push({
        functionName: fns.map((f) => f.name).filter((n, i, a) => a.indexOf(n) === i).join(", "),
        occurrences: fns.map((f) => ({
          filePath: f.filePath,
          line: f.line,
          similarity: Math.round(sim * 100),
        })),
        kind: "structural",
      });
    }
  }

  return groups;
}
