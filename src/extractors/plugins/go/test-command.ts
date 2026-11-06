import type { TestTarget } from "../../../types/language-plugin.js";

const TEST_FUNCTION = /^(Test|Benchmark|Example|Fuzz)\w*$/;

/** The filter one package's tests ask for: top-level test functions, subtests a suite runs, and whether anything is unfiltered. */
interface PackageTests {
  functions: Set<string>;
  suiteMethods: Set<string>;
  whole: boolean;
}

/**
 * `go test` over the packages (directories) holding the tests, one command per distinct filter: a `-run` filter
 * applies to every package a command names, so a package whose whole file is wanted never shares one with a
 * package filtered to a test. A suite method (testify's `ClubSuite.TestSave`) is no top-level test — the runner
 * function (`TestClubSuite`) is, and the method is its subtest — so it is selected as a subtest of any top-level
 * test, `-run '/^(TestSave)$'`, in a command of its own (the runner's name is not stated here).
 */
export function goTestCommand(tests: readonly TestTarget[]): string | null {
  const byDir = new Map<string, PackageTests>();
  for (const t of tests) {
    const dir = t.file.includes("/") ? `./${t.file.slice(0, t.file.lastIndexOf("/"))}` : ".";
    const pkg = byDir.get(dir) ?? byDir.set(dir, { functions: new Set(), suiteMethods: new Set(), whole: false }).get(dir)!;
    let filtered = false;
    for (const name of t.names) {
      const dot = name.lastIndexOf(".");
      const leaf = name.slice(dot + 1);
      if (!TEST_FUNCTION.test(leaf)) continue;
      filtered = true;
      (dot >= 0 ? pkg.suiteMethods : pkg.functions).add(leaf);
    }
    // No test function named: the whole file (so its package) is wanted.
    if (!filtered) pkg.whole = true;
  }
  if (!byDir.size) return null;
  const commands = new Map<string, string[]>();
  const add = (filter: string, dir: string): void => {
    (commands.get(filter) ?? commands.set(filter, []).get(filter)!).push(dir);
  };
  for (const [dir, pkg] of [...byDir].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (pkg.whole) { add("", dir); continue; }
    if (pkg.functions.size) add(` -run '^(${[...pkg.functions].sort().join("|")})$'`, dir);
    if (pkg.suiteMethods.size) add(` -run '/^(${[...pkg.suiteMethods].sort().join("|")})$'`, dir);
  }
  return [...commands].map(([filter, dirs]) => `go test ${dirs.join(" ")}${filter}`).join(" && ");
}
