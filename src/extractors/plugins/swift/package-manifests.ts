import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** SwiftPM: `.package(url: …, from: …)` entries of `Package.swift`. */
function parseSwiftPackage(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  // .package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.0.0")
  // .package(name: "Foo", url: "...", .upToNextMajor(from: "1.0.0"))
  const re = /\.package\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const args = m[1]!;
    const url = args.match(/url:\s*"([^"]+)"/)?.[1];
    let name = args.match(/name:\s*"([^"]+)"/)?.[1];
    if (!name && url) name = url.replace(/\.git$/, "").replace(/\/+$/, "").split("/").pop();
    if (!name) continue;
    const version = args.match(/(?:from|exact|revision|branch):\s*"([^"]+)"/)?.[1] ?? null;
    out.push(declared(name, version, "swiftpm", "prod", declaredIn));
  }
  return out;
}

/** CocoaPods: `pod 'Name', 'version'` lines of a `Podfile`. */
function parsePodfile(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^pod\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/);
    if (!m) continue;
    out.push(declared(m[1]!.split("/")[0]!, m[2] ?? null, "cocoapods", "prod", declaredIn)); // strip Pod/Subspec
  }
  return out;
}

/**
 * Swift `import Alamofire` → the module name; Obj-C `#import
 * <AFNetworking/AFNetworking.h>` or `@import AFNetworking;` → its first path
 * segment, header extension stripped. One module namespace for both managers.
 */
function moduleKey(s: string): string | null {
  const head = s.split("/")[0]!.replace(/\.(h|hpp|m|mm)$/, "");
  return /^[A-Za-z_]\w*$/.test(head) ? head.toLowerCase() : null;
}

export const swiftpmPackageManager: PackageManagerSpec = {
  ecosystem: "swiftpm",
  manifests: [{ files: ["Package.swift"], parse: (text, file) => parseSwiftPackage(text, file.declaredIn) }],
  importKey: moduleKey,
};

export const cocoapodsPackageManager: PackageManagerSpec = {
  ecosystem: "cocoapods",
  manifests: [{ files: ["Podfile"], parse: (text, file) => parsePodfile(text, file.declaredIn) }],
  importKey: moduleKey,
};
