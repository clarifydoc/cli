import type { ClassInfo, FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * QML→C++ bridge: connect QML component usages and singleton calls to the C++
 * classes that back them. Qt registers C++ types into QML modules via the
 * `QML_NAMED_ELEMENT(Name)` / `QML_ELEMENT` macros (tagged as `qml-element:X`
 * class decorators by the cpp plugin) — the QML side then instantiates
 * `ControlProxy { … }` or calls `Mixxx.PlayerManager.getPlayer(...)`. Neither
 * side has a name-resolvable import edge (the module is assembled by the Qt
 * build), so without this bridge every QML screen dead-ends at the .qml file
 * and never reaches the C++ engine (or, through it, the DAO/database layer).
 *
 * Two link shapes, both INFERRED:
 *   - component usage: `<qml file>::<component>` → `<cpp file>::<Class>`
 *     (one per usage site, callName = the QML tag).
 *   - singleton/attached call: `<qml file>::<fn or <component>>` →
 *     `<cpp file>::<Class>.<method>` when the call's ROOT segment is a
 *     registered QML name and the leaf matches a method on the class
 *     (falls back to the class itself when the method is unknown).
 */
export class QmlCppBridgeResolver implements DispatchResolver {
  readonly id = "qml-cpp";
  readonly languages: Language[] = ["qml", "cpp", "c", "objc"];
  readonly priority = 40;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    // QML type name → registering C++ class.
    const registry = new Map<string, { file: string; cls: ClassInfo }>();
    for (const a of analyses) {
      if (a.language === "qml") continue;
      for (const cls of a.classes ?? []) {
        for (const dec of cls.decorators) {
          if (dec.startsWith("qml-element:")) {
            const qmlName = dec.slice("qml-element:".length);
            if (!registry.has(qmlName)) registry.set(qmlName, { file: a.filePath, cls });
          }
        }
      }
    }
    if (registry.size === 0) return [];

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const add = (l: SymbolLink) => {
      const k = `${l.sourceFile}|${l.sourceSymbol}|${l.sourceLine}|${l.targetFile}|${l.targetSymbol}`;
      if (!seen.has(k)) {
        seen.add(k);
        links.push(l);
      }
    };

    for (const a of analyses) {
      if (a.language !== "qml") continue;

      // Component instantiations: `ControlProxy { … }` (leaf tag already stored).
      for (const sub of a.subComponents ?? []) {
        const hit = registry.get(sub.name);
        if (!hit) continue;
        add({
          sourceFile: a.filePath,
          sourceSymbol: "<component>",
          sourceLine: sub.line,
          callName: sub.name,
          targetFile: hit.file,
          targetSymbol: hit.cls.name,
          targetLine: hit.cls.line,
          confidence: "INFERRED",
        });
      }

      // Singleton/attached calls inside QML functions: `PlayerManager.getPlayer(...)`
      // (the module alias `Mixxx.` is already dropped by the two-segment call regex).
      for (const fn of a.functions ?? []) {
        for (const call of fn.calls ?? []) {
          const parts = call.name.split(".");
          if (parts.length < 2) continue;
          const hit = registry.get(parts[0]!);
          if (!hit) continue;
          const leaf = parts[parts.length - 1]!;
          const method = hit.cls.methods.find((m) => m.name === leaf);
          add({
            sourceFile: a.filePath,
            sourceSymbol: fn.name,
            sourceLine: call.line,
            callName: call.name,
            targetFile: hit.file,
            targetSymbol: method ? `${hit.cls.name}.${method.name}` : hit.cls.name,
            targetLine: method?.line ?? hit.cls.line,
            confidence: "INFERRED",
          });
        }
      }
    }
    return links;
  }
}
