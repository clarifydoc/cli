import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasGradleDep } from "../shared/project-info-queries.js";

/** Grails: its Gradle plugin / BOM, or the `grails-app/` tree a Grails app is built around. */
export const groovyFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "grails",
    name: "Grails",
    check: (info) => hasGradleDep(info, "org.grails") || info.markerFiles.includes("grails-app"),
    detectedVia: "build file dependency or grails-app/",
  },
];
