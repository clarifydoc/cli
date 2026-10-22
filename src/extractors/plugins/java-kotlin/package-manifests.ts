import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** Maven: `pom.xml` `<dependency>` blocks as `group:artifact`. */
function parsePom(raw: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  // What the project depends on: not what a comment shows, a `<dependencyManagement>`
  // pins for its children, or a build plugin needs to run.
  const text = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/gi, "")
    .replace(/<plugin>[\s\S]*?<\/plugin>/gi, "");
  // `${jackson.version}` from the POM's own `<properties>`.
  const props = new Map<string, string>();
  for (const block of text.matchAll(/<properties>([\s\S]*?)<\/properties>/gi)) {
    for (const p of block[1]!.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props.set(p[1]!, p[2]!);
  }
  const resolve = (v: string): string => v.replace(/\$\{([\w.-]+)\}/g, (all, k: string) => props.get(k) ?? all);
  const re = /<dependency>([\s\S]*?)<\/dependency>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1]!;
    const group = body.match(/<groupId>\s*([^<]+?)\s*<\/groupId>/i)?.[1];
    const artifact = body.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/i)?.[1];
    const written = body.match(/<version>\s*([^<]+?)\s*<\/version>/i)?.[1];
    const version = written ? resolve(written) : null;
    const scope = /test/i.test(body.match(/<scope>\s*([^<]+?)\s*<\/scope>/i)?.[1] ?? "") ? "dev" : "prod";
    if (!artifact) continue;
    const name = group ? `${group}:${artifact}` : artifact;
    out.push(declared(name, version, "maven", scope, declaredIn));
  }
  return out;
}

/** Gradle: `implementation "group:artifact:version"` and the other configurations. */
function parseGradle(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  // implementation "group:artifact:version" / api('group:artifact:version') / testImplementation ...
  // The parenthesis is optional: the Groovy DSL writes `implementation "g:a:v"`.
  const re = /\b(\w*[iI]mplementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|kapt|annotationProcessor|developmentOnly)\s*\(?\s*['"]([^'"]+:[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const config = m[1]!;
    const coord = m[2]!; // group:artifact[:version]
    const parts = coord.split(":");
    if (parts.length < 2) continue;
    const name = `${parts[0]}:${parts[1]}`;
    const version = parts[2] ?? null;
    const scope: PackageScope = /^test/i.test(config) ? "dev" : "prod";
    out.push(declared(name, version, "gradle", scope, declaredIn));
  }
  return out;
}

// A Java/Kotlin import names a package, never an artifact: usage stays unknown.
export const mavenPackageManager: PackageManagerSpec = {
  ecosystem: "maven",
  manifests: [{ files: ["pom.xml"], parse: (text, file) => parsePom(text, file.declaredIn) }],
};

export const gradlePackageManager: PackageManagerSpec = {
  ecosystem: "gradle",
  manifests: [
    { files: ["build.gradle.kts", "build.gradle"], firstOnly: true, parse: (text, file) => parseGradle(text, file.declaredIn) },
  ],
};
