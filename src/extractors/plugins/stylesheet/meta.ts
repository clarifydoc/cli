import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { lessSpec, sassSpec, scssSpec } from "./index.js";
import { lessManifest, sassManifest, scssManifest } from "./manifest.js";

/**
 * No reachability model: a stylesheet is markup's companion, never judged
 * dead — its imports are still read as mention sources.
 */
export const scssMeta: LanguagePluginMeta = { ...scssManifest, regexSpec: scssSpec() };
export const sassMeta: LanguagePluginMeta = { ...sassManifest, regexSpec: sassSpec() };
export const lessMeta: LanguagePluginMeta = { ...lessManifest, regexSpec: lessSpec() };
