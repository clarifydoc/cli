import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** Maven or Gradle (through the wrapper when the project has one); Spring Boot's run goal. */
export function jvmProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const has = (f: string) => root.entries.includes(f);
  if (has("pom.xml")) {
    const mvn = has("mvnw") ? "./mvnw" : "mvn";
    const pom = (root.read("pom.xml") ?? "").replace(/<!--[\s\S]*?-->/g, "");
    // A parent or aggregator POM runs nothing itself, and a plugin it only manages is its children's.
    const runs = !/<packaging>\s*pom\s*<\/packaging>/.test(pom) && /spring-boot-maven-plugin/.test(pom.replace(/<pluginManagement>[\s\S]*?<\/pluginManagement>/g, ""));
    return [
      { kind: "build", command: `${mvn} package`, source: "pom.xml" },
      { kind: "test", command: `${mvn} test`, source: "pom.xml" },
      ...(runs ? [{ kind: "start" as const, command: `${mvn} spring-boot:run`, source: "pom.xml spring-boot-maven-plugin" }] : []),
    ];
  }
  const gradleFile = ["build.gradle.kts", "build.gradle"].find(has);
  if (gradleFile) {
    const gradle = has("gradlew") ? "./gradlew" : "gradle";
    const build = root.read(gradleFile) ?? "";
    return [
      { kind: "build", command: `${gradle} build`, source: gradleFile },
      { kind: "test", command: `${gradle} test`, source: gradleFile },
      ...(/org\.springframework\.boot/.test(build) ? [{ kind: "start" as const, command: `${gradle} bootRun`, source: `${gradleFile} Spring Boot plugin` }]
        : /\bapplication\b/.test(build) ? [{ kind: "start" as const, command: `${gradle} run`, source: `${gradleFile} application plugin` }] : []),
    ];
  }
  return [];
}
