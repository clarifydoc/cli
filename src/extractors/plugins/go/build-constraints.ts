/**
 * Go build constraints: whether a build for the default target leaves a file out
 * (`FileAnalysis.excludedFromDefaultBuild`).
 *
 * The default target is Linux on amd64 — where `go test` usually runs in CI. A
 * file is left out when its name ends in another GOOS or GOARCH
 * (`diagnostics_windows.go`, `lift_darwin_arm64.go`), or when its `//go:build`
 * line (or the older `// +build` lines) is false for that target. A tag the
 * target does not fix (`integration`, `cgo`, a Go release) makes the line
 * undecided, and an undecided file is kept: the run may set it.
 */

const GOOS = new Set([
  "aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "js", "linux", "nacl", "netbsd",
  "openbsd", "plan9", "solaris", "wasip1", "windows", "zos",
]);
const GOARCH = new Set([
  "386", "amd64", "amd64p32", "arm", "armbe", "arm64", "arm64be", "loong64", "mips", "mipsle", "mips64", "mips64le",
  "mips64p32", "mips64p32le", "ppc", "ppc64", "ppc64le", "riscv", "riscv64", "s390", "s390x", "sparc", "sparc64", "wasm",
]);
/** Tags the default target sets: its OS, its architecture, and `unix` (Linux is one). */
const DEFAULT_TAGS = new Set(["linux", "amd64", "unix"]);
/** Every tag the target decides: an OS or architecture it is not is false. */
const DECIDED = new Set([...GOOS, ...GOARCH, "unix"]);

/** True, false, or undecided (null): a tag the default target does not fix. */
type Tri = boolean | null;

const not = (a: Tri): Tri => (a === null ? null : !a);
const and = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === null || b === null ? null : true);
const or = (a: Tri, b: Tri): Tri => (a === true || b === true ? true : a === null || b === null ? null : false);
const tag = (name: string): Tri => (DEFAULT_TAGS.has(name) ? true : DECIDED.has(name) ? false : null);

/** A `//go:build` expression (`windows`, `!windows && (amd64 || arm64)`) for the default target; null when undecided or unreadable. */
export function evalGoBuildExpr(expr: string): Tri {
  const tokens = expr.match(/&&|\|\||[!()]|[\w.]+/g) ?? [];
  let i = 0;
  let ok = true;
  const primary = (): Tri => {
    const t = tokens[i++];
    if (t === "!") return not(primary());
    if (t === "(") {
      const v = disjunction();
      if (tokens[i++] !== ")") ok = false;
      return v;
    }
    if (!t || !/^[\w.]+$/.test(t)) {
      ok = false;
      return null;
    }
    return tag(t);
  };
  const conjunction = (): Tri => {
    let v = primary();
    while (tokens[i] === "&&") {
      i++;
      v = and(v, primary());
    }
    return v;
  };
  const disjunction = (): Tri => {
    let v = conjunction();
    while (tokens[i] === "||") {
      i++;
      v = or(v, conjunction());
    }
    return v;
  };
  const v = disjunction();
  return ok && i === tokens.length ? v : null;
}

/** One old-style `// +build` line: space-separated options OR'd, comma-separated terms AND'd. */
function evalPlusBuildLine(line: string): Tri {
  let any: Tri = false;
  for (const option of line.trim().split(/\s+/)) {
    let all: Tri = true;
    for (const term of option.split(",")) all = and(all, term.startsWith("!") ? not(tag(term.slice(1))) : tag(term));
    any = or(any, all);
  }
  return any;
}

/** The GOOS / GOARCH a file name constrains it to (`x_windows.go`, `x_linux_arm64_test.go`), as the go tool reads it. */
function fileNameConstraint(relativePath: string): { written: string; value: boolean } | null {
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1).replace(/\.go$/, "").replace(/_test$/, "");
  const parts = base.split("_");
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]!;
  const prev = parts.length >= 3 ? parts[parts.length - 2]! : null;
  if (prev && GOOS.has(prev) && GOARCH.has(last)) return { written: `_${prev}_${last}`, value: DEFAULT_TAGS.has(prev) && DEFAULT_TAGS.has(last) };
  if (GOOS.has(last)) return { written: `_${last}`, value: DEFAULT_TAGS.has(last) };
  if (GOARCH.has(last)) return { written: `_${last}`, value: DEFAULT_TAGS.has(last) };
  return null;
}

/**
 * The constraint, as written, that leaves the file out of a Linux/amd64 build; null when that build
 * compiles it or the constraint is undecided. Only the header counts: constraint lines come before
 * the package clause, among comments and blank lines.
 */
export function goDefaultBuildExclusion(rawSource: string, relativePath: string): string | null {
  const byName = fileNameConstraint(relativePath);
  if (byName && !byName.value) return `file name ${byName.written}`;
  const plusLines: string[] = [];
  let inBlock = false;
  for (const raw of rawSource.split("\n", 200)) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      inBlock = !line.includes("*/");
      continue;
    }
    const goBuild = /^\/\/go:build\s+(.+)$/.exec(line);
    if (goBuild) {
      // `//go:build` supersedes any `// +build` lines.
      return evalGoBuildExpr(goBuild[1]!) === false ? `//go:build ${goBuild[1]!.trim()}` : null;
    }
    const plus = /^\/\/\s*\+build\s+(.+)$/.exec(line);
    if (plus) {
      plusLines.push(plus[1]!);
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    break;
  }
  let all: Tri = true;
  for (const l of plusLines) all = and(all, evalPlusBuildLine(l));
  return plusLines.length && all === false ? plusLines.map((l) => `// +build ${l.trim()}`).join("; ") : null;
}
