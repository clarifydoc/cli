import { createHash } from "crypto";
import type { ExternalPackage, PackageEcosystem } from "../types/analysis.js";
import type { Summary } from "./types.js";

/**
 * The declared dependencies as a CycloneDX 1.5 SBOM (JSON): each package
 * with its purl, the version the lockfile installed (else an exact declared
 * one), its licence where the lockfile records it, and its scope — a dev or
 * peer dependency is `excluded` from what ships, an optional one `optional`.
 * What the code declares, not a scan of an installed tree: a transitive
 * dependency appears only when a manifest names it.
 */

/** purl type per ecosystem (package-url spec); one with none is `generic`. */
const PURL_TYPE: Partial<Record<PackageEcosystem, string>> = {
  npm: "npm", nuget: "nuget", pypi: "pypi", maven: "maven", gradle: "maven", composer: "composer", cargo: "cargo",
  go: "golang", rubygems: "gem", pub: "pub", swiftpm: "swift", cocoapods: "cocoapods", conan: "conan", cpan: "cpan",
  hex: "hex", hackage: "hackage", clojars: "clojars", cran: "cran", conda: "conda", luarocks: "luarocks",
};

const enc = (s: string) => encodeURIComponent(s).replace(/%2F/g, "/");

/** A package's purl: `pkg:npm/%40scope/name@1.2.3`, `pkg:maven/group/artifact@1.0`. */
export function purlOf(p: Pick<ExternalPackage, "ecosystem" | "name">, version?: string): string {
  const type = PURL_TYPE[p.ecosystem] ?? "generic";
  let path: string;
  if (type === "maven" && p.name.includes(":")) path = p.name.split(":").map(enc).join("/");
  else if (type === "npm" && p.name.startsWith("@")) path = `%40${enc(p.name.slice(1))}`;
  else if (type === "pypi") path = enc(p.name.toLowerCase().replace(/[-_.]+/g, "-"));
  else path = p.name.split("/").map(enc).join("/");
  return `pkg:${type}/${path}${version ? `@${enc(version)}` : ""}`;
}

/** The version a component is: the installed one, else a declared spec that is exact. */
function versionOf(p: ExternalPackage): string | undefined {
  if (p.resolvedVersion) return p.resolvedVersion;
  const v = p.version?.trim();
  return v && /^v?\d+(?:\.\d+)*(?:[-+][\w.-]+)?$/.test(v) ? v.replace(/^v/, "") : undefined;
}

export function toCycloneDx(summary: Summary, name: string): Record<string, unknown> {
  const packages = ((summary as { externalPackages?: ExternalPackage[] }).externalPackages ?? []).filter((p) => p.ecosystem !== "git");
  const components = packages
    .map((p) => {
      const version = versionOf(p);
      const purl = purlOf(p, version);
      const license = p.license?.trim();
      return {
        type: "library",
        "bom-ref": purl,
        name: p.name,
        ...(version ? { version } : {}),
        purl,
        scope: p.scope === "prod" ? "required" : p.scope === "optional" ? "optional" : "excluded",
        ...(license ? { licenses: [/^[A-Za-z0-9.+-]+$/.test(license) ? { license: { id: license } } : { expression: license }] } : {}),
        properties: [
          { name: "clarifydoc:declaredIn", value: p.declaredIn },
          ...(p.version && p.version !== version ? [{ name: "clarifydoc:declaredVersion", value: p.version }] : []),
          ...(p.used === false ? [{ name: "clarifydoc:used", value: "false" }] : []),
        ],
      };
    })
    .sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));
  const at = (summary as { analyzedAt?: string }).analyzedAt ?? new Date(0).toISOString();
  const hash = createHash("sha256").update(`${name}\0${at}\0${components.map((c) => c.purl).join("\n")}`).digest("hex");
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    // Stable for the same analysis: an RFC 4122 v4-shaped id from the content.
    serialNumber: `urn:uuid:${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    version: 1,
    metadata: {
      timestamp: at,
      tools: { components: [{ type: "application", name: "clarifydoc" }] },
      component: { type: "application", name, "bom-ref": `app:${name}` },
    },
    components,
  };
}
