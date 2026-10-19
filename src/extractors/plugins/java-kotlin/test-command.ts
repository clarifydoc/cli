import type { TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/** Maven `-Dtest=Class#method+method` or Gradle `--tests Class.method`, by the build the project declares. */
export function jvmTestCommand(tests: readonly TestTarget[], ctx: TestCommandContext): string | null {
  const byClass = new Map<string, Set<string>>();
  for (const t of tests) {
    const cls = t.file.slice(t.file.lastIndexOf("/") + 1).replace(/\.(java|kt|kts)$/, "");
    const methods = byClass.get(cls) ?? byClass.set(cls, new Set()).get(cls)!;
    for (const n of t.names) {
      const [owner, method] = n.includes(".") ? [n.slice(0, n.lastIndexOf(".")), n.slice(n.lastIndexOf(".") + 1)] : [cls, n];
      if (owner === cls && method && method !== "<setup>") methods.add(method);
    }
  }
  if (!byClass.size) return null;
  const classes = [...byClass].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const gradle = [...ctx.manifests].some((m) => m.startsWith("build.gradle")) && !ctx.manifests.has("pom.xml");
  if (gradle) return `./gradlew test ${classes.flatMap(([c, ms]) => (ms.size ? [...ms].sort().map((m) => `--tests '${c}.${m}'`) : [`--tests '${c}'`])).join(" ")}`;
  return `mvn test -Dtest='${classes.map(([c, ms]) => (ms.size ? `${c}#${[...ms].sort().join("+")}` : c)).join(",")}'`;
}
