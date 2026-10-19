import type { TestTarget } from "../../../types/language-plugin.js";

/** `go test ./pkg -run '^(TestA|TestB)$'` over the packages (directories) holding the tests. */
export function goTestCommand(tests: readonly TestTarget[]): string | null {
  const dirs = [...new Set(tests.map((t) => (t.file.includes("/") ? `./${t.file.slice(0, t.file.lastIndexOf("/"))}` : ".")))].sort();
  if (!dirs.length) return null;
  const names = [...new Set(tests.flatMap((t) => t.names).map((n) => n.split(".").pop()!).filter((n) => /^(Test|Benchmark|Example|Fuzz)\w*/.test(n)))].sort();
  return `go test ${dirs.join(" ")}${names.length ? ` -run '^(${names.join("|")})$'` : ""}`;
}
