import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { jspSpec } from "./index.js";
import { jspFrameworkRules } from "./frameworks.js";

/**
 * JSP views — the screen tier of classic Java web monoliths. Screens +
 * interactive elements + include-imports only; behaviour lives in the Java
 * action classes that Spring Web Flow / Struts wire to these views (joined by
 * the webflow dispatch resolver).
 */
export const jspMeta: LanguagePluginMeta = {
  language: "jsp",
  parsing: "regex",
  extensions: jspSpec.extensions,
  regexSpec: jspSpec,
  // A JSP is referenced by view PATH (webflow `view="/account/x"`), never
  // imported by module name; keeping .jsp out of the import path map avoids
  // basename collisions with same-named Java/JS files.
  importTarget: false,
  frameworkRules: jspFrameworkRules,
};
