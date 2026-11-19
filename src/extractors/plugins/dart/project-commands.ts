import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** `flutter` tooling for a pubspec that depends on the Flutter SDK, else the Dart SDK's. */
export function dartProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const pubspec = root.read("pubspec.yaml");
  if (pubspec === undefined) return [];
  const flutter = /^\s+flutter\s*:[ \t]*(?:#.*)?\r?\n(?:\s*#.*\r?\n)*\s+sdk\s*:\s*flutter\b/m.test(pubspec);
  const out: ProjectCommand[] = [{ kind: "test", command: flutter ? "flutter test" : "dart test", source: "pubspec.yaml" }];
  out.push(flutter ? { kind: "start", command: "flutter run", source: "pubspec.yaml" } : { kind: "start", command: "dart run", source: "pubspec.yaml" });
  return out;
}
