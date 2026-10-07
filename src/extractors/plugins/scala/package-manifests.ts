import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** sbt: `"group" %% "artifact" % "version" [% Test]` — Maven coordinates. */
function parseSbt(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const re = /"([^"]+)"\s*%%?\s*"([^"]+)"\s*%\s*"([^"]+)"(?:\s*%\s*(\w+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const scope: PackageScope = /^(test|it)$/i.test(m[4] ?? "") ? "dev" : "prod";
    out.push(declared(`${m[1]}:${m[2]}`, m[3]!, "maven", scope, declaredIn));
  }
  return out;
}

/** sbt resolves from Maven repositories: its packages join Java's `maven` ecosystem. */
export const sbtPackageManager: PackageManagerSpec = {
  ecosystem: "maven",
  manifests: [{ files: ["build.sbt"], parse: (text, file) => parseSbt(text, file.declaredIn) }],
};
