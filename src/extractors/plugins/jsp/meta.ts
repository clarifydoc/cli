import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { jspSpec } from "./index.js";
import { jspManifest } from "./manifest.js";

/**
 * JSP views — the screen tier of classic Java web monoliths. Screens +
 * interactive elements + include-imports only; behaviour lives in the Java
 * action classes that Spring Web Flow / Struts wire to these views (joined by
 * the webflow dispatch resolver).
 */
export const jspMeta: LanguagePluginMeta = {
  ...jspManifest,
  regexSpec: jspSpec,
};
