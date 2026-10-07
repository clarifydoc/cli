import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { qmlFrameworkRules } from "./frameworks.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const qmlManifest: LanguagePluginManifest = {
  language: "qml",
  parsing: "regex",
  extensions: [".qml"],
  importTarget: false,
  frameworkImportHints: { QtQuick: "qt-quick" },
  frameworkRules: qmlFrameworkRules,
  // QmlCppBridgeResolver joins QML elements to their registering C++/C/ObjC
  // classes — a Qt project with no .qml discovered-yet still needs the bridge
  // when C++ registers QML types.
  dispatchLanguages: ["cpp", "c", "objc"],
};
