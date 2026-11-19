import type { ProjectCommand, ProjectRootView, TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/**
 * CMake's out-of-source build, and CTest when the root `CMakeLists.txt` registers tests (`enable_testing`,
 * `include(CTest)`, `add_test`, a `*_discover_tests` call). `source` says when the registered names are the
 * framework's own (`gtest_discover_tests`, `catch_discover_tests`: `Suite.Case`), the only names a `-R` filter can state.
 */
export function cmakeProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const text = root.read("CMakeLists.txt")?.replace(/#.*$/gm, "");
  if (text === undefined) return [];
  const out: ProjectCommand[] = [
    { kind: "build", command: "cmake -S . -B build && cmake --build build", source: "CMakeLists.txt" },
  ];
  if (/\b(?:enable_testing|add_test|include\s*\(\s*CTest\s*\))/i.test(text) || /\w+_discover_tests\s*\(/.test(text)) {
    const discover = /\b(?:gtest|catch)_discover_tests\s*\(/i.test(text);
    out.push({ kind: "test", command: "ctest --test-dir build --output-on-failure", source: discover ? "CMakeLists.txt gtest_discover_tests" : "CMakeLists.txt" });
  }
  return out;
}

/**
 * `ctest --test-dir build -R '^(ClubTest\.Creates|…)$'`: CTest's name filter, stated only for a project whose
 * tests are discovered by name (`Suite.Case`) and for names of that shape — every other test runs the whole CTest suite,
 * because a filter that matches nothing runs nothing and still succeeds.
 */
export function ctestCommand(tests: readonly TestTarget[], ctx?: TestCommandContext): string | null {
  const project = ctx?.projectTests?.find((c) => c.command.startsWith("ctest"));
  if (!project || !tests.length) return null;
  const names = tests.flatMap((t) => t.names);
  const suites = [...new Set(names)].filter((n) => /^[A-Z]\w*\.\w+$/.test(n)).sort();
  if (!project.source.includes("_discover_tests") || !suites.length || suites.length < names.length) return project.command;
  return `ctest --test-dir build -R '^(${suites.map((n) => n.replace(".", "\\.")).join("|")})$'`;
}
