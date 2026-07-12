import type { FrameworkRule } from "../../../types/language-plugin.js";

/** Java web view tier — JSP pages exist. */
export const jspFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "jsp",
    name: "JSP",
    check: (info) => info.jspFiles.length > 0,
    detectedVia: ".jsp files",
  },
];
