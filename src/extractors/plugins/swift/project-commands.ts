import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** SwiftPM builds and tests the package; `swift run` when it declares an executable target. */
export function swiftProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const text = root.read("Package.swift");
  if (text === undefined) return [];
  const pkg = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const out: ProjectCommand[] = [
    { kind: "build", command: "swift build", source: "Package.swift" },
    { kind: "test", command: "swift test", source: "Package.swift" },
  ];
  if (/\.executableTarget\s*\(|\.executable\s*\(/.test(pkg)) out.push({ kind: "start", command: "swift run", source: "Package.swift" });
  return out;
}
