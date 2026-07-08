import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { qmlSpec } from "./index.js";

/**
 * QML (Qt Quick) — declarative UI files of Qt desktop/mobile apps. Each `.qml`
 * file is one component: it becomes a screen, its child component tags feed
 * componentUsage (leaf tag joins the sibling `<Name>.qml` file), and its
 * interaction signal handlers (`onClicked:` …) become interactive elements.
 */
export const qmlMeta: LanguagePluginMeta = {
  language: "qml",
  parsing: "regex",
  extensions: qmlSpec.extensions,
  regexSpec: qmlSpec,
  frameworkImportHints: {
    QtQuick: "qt-quick",
  },
  // QML components reference each other by TYPE NAME (implicit directory
  // import), not by module path — `import "Theme"` points at a directory.
  // Keeping .qml out of the import path map avoids basename collisions with
  // same-named JS helpers.
  importTarget: false,
};
