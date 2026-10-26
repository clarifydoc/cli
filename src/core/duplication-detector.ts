import type { FileAnalysis, DuplicateGroup, Language } from "../types/analysis.js";
import { BUILTIN_MEMBERS_BY_LANGUAGE } from "../extractors/registry.js";
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

/** Calls into code a function needs before its shape is compared. */
const MIN_SHAPE_CALLS = 3;

/** How alike, by `shapeSimilarity`, a structural duplicate must be to the first of its bucket. */
const STRUCTURAL_SHAPE_MIN = 0.8;

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

/** The words of an identifier, lower-cased and singular: `fetchOperatorCredits` → fetch, operator, credit. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase().replace(/(?<=..)s$/, ""));
}

/**
 * The shape of a call: its kind and its leaf name without the words of the
 * entity the function is about — the words of the function's own name and of
 * its file's. `updatePost` calling `postService.updatePost(…)` and
 * `updateUser` calling `userService.updateUser(…)` both make a
 * `cross-file:update` call: two copies of one routine written for different
 * entities differ in every name and in nothing else.
 */
function callShape(call: { name: string; kind: string }, entityWords: ReadonlySet<string>): string {
  const leaf = call.name.split(/::|->|[.:#]/).pop() ?? call.name;
  const words = wordsOf(leaf.replace(/^new\s+/, ""));
  // Each entity word reads `*`: `ClubsAPI.getPlayers` in `getPlayers` and
  // `LeaguesAPI.getMatches` in `getMatches` are both `*`.
  const shape = words.map((w) => (entityWords.has(w) ? "*" : w)).join("-").replace(/\*(?:-\*)+/g, "*");
  return `${call.kind}:${shape}`;
}

/** The entity words of a function: those of its name and its file's base name. */
function entityWordsOf(fnName: string, filePath: string): Set<string> {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
  return new Set([...wordsOf(fnName), ...wordsOf(base)]);
}

/** Longest common subsequence of two token lists. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * How alike two functions' call sequences are by shape (`callShape`), in
 * order: the longest common subsequence over the longer sequence. Names are
 * not compared, so the measure finds the copy made for another entity and is
 * not fooled by shared incidental calls (`console.log`, `JSON.stringify`)
 * that made unrelated functions look alike by name.
 */
function shapeSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 1 : 0;
  return lcsLength(a, b) / Math.max(a.length, b.length);
}

/**
 * A function's call shapes, in order — only its calls into code (a leaf the
 * language lists as a builtin member, `includes`, `push`, `then`, is
 * evidence of nothing). Null when fewer than three remain: two functions that
 * each call `includes` twice, or two one-line wrappers forwarding to a store
 * (`getStore().save(…)`), share no shape worth reporting.
 */
function shapesOf(fn: { name: string; calls: { name: string; kind: string }[] }, filePath: string, language: Language): string[] | null {
  const builtins = BUILTIN_MEMBERS_BY_LANGUAGE.get(language);
  const entity = entityWordsOf(fn.name, filePath);
  const calls = fn.calls.filter((c) => !builtins?.has(c.name.split(/::|->|[.:#]/).pop() ?? c.name));
  return calls.length >= MIN_SHAPE_CALLS ? calls.map((c) => callShape(c, entity)) : null;
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
  const fingerprints = new Map<string, { filePath: string; language: Language; name: string; line: number; fn: FileAnalysis["functions"][0] }[]>();

  for (const a of authored) {
    for (const fn of a.functions) {
      if (fn.name === "<setup>") continue;
      if (fn.endLine - fn.line < 5) continue; // skip very short functions
      if (fn.calls.length < 2) continue; // need some structure to compare

      const fp = buildFingerprint(fn);
      const existing = fingerprints.get(fp) ?? [];
      existing.push({ filePath: a.filePath, language: a.language, name: fn.name, line: fn.line, fn });
      fingerprints.set(fp, existing);
    }
  }

  for (const [_fp, fns] of fingerprints) {
    if (fns.length < 2) continue;

    // Same fingerprint bucket ≠ same code — keep only members that make the
    // first one's calls in the same order by shape (kind + leaf without the
    // entity's words: the copy written for another entity), or the same
    // calls by name.
    const anchorShape = shapesOf(fns[0].fn, fns[0].filePath, fns[0].language);
    const similarity = (f: (typeof fns)[number]): number => {
      const shape = shapesOf(f.fn, f.filePath, f.language);
      const byShape = anchorShape && shape ? shapeSimilarity(anchorShape, shape) : 0;
      const byName = callSimilarity(fns[0].fn.calls, f.fn.calls);
      return Math.max(byShape >= STRUCTURAL_SHAPE_MIN ? byShape : 0, byName > 0.7 ? byName : 0);
    };
    const similar = [fns[0], ...fns.slice(1).filter((f) => similarity(f) > 0)];
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
        similarity: Math.round(similarity(f) * 100),
      })),
      kind: "structural",
    });
  }

  return groups;
}
