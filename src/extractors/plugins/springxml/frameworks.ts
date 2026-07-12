import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasGradleDep, hasMavenDep } from "../shared/project-info-queries.js";

/**
 * Spring Web Flow — flow definition XMLs (in-house wrappers pull the jar in
 * transitively, so the build file often never names it) or an explicit dep.
 */
export const springxmlFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "spring-webflow",
    name: "Spring Web Flow",
    check: (info) =>
      info.webflowFiles.length > 0 ||
      hasMavenDep(info, "spring-webflow") ||
      hasGradleDep(info, "spring-webflow"),
    detectedVia: "webflow XML definitions / build dependency",
  },
];
