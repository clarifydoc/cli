import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { qmlSpec } from "./index.js";
import { qmlManifest } from "./manifest.js";
import { QmlCppBridgeResolver } from "./dispatch.js";
import { qmlReachability } from "./reachability.js";

/**
 * QML (Qt Quick) — declarative UI files of Qt desktop/mobile apps. Each `.qml`
 * file is one component: it becomes a screen, its child component tags feed
 * componentUsage (leaf tag joins the sibling `<Name>.qml` file), and its
 * interaction signal handlers (`onClicked:` …) become interactive elements.
 */
export const qmlMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: qmlReachability,
  ...qmlManifest,
  regexSpec: qmlSpec,
  dispatchResolvers: [new QmlCppBridgeResolver()],
};
