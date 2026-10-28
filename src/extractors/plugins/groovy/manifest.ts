import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { groovyFrameworkRules } from "./frameworks.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const groovyManifest: LanguagePluginManifest = {
  language: "groovy",
  family: "jvm",
  // Gradle declares Groovy's dependencies (read by java-kotlin's gradle manager).
  packageEcosystems: ["maven"],
  parsing: "regex",
  extensions: [".groovy", ".gvy", ".gy", ".gsh"],
  // Gradle/Maven source sets: below `src/<set>/groovy/` every directory is a package.
  packageRoots: [/(?:^|\/)src\/[^/]+\/groovy\//],
  // A Jenkins pipeline is a Groovy script with no extension.
  namedFiles: ["Jenkinsfile"],
  testFilePatterns: [/Spec\.groovy$/, /Tests?\.groovy$/, /(?:^|\/)src\/(?:test|integration-test)\//],
  externalModulePrefixes: ["groovy.", "java.", "javax.", "jakarta.", "org.springframework.", "grails.", "org.grails.", "spock.", "io.micronaut.", "org.codehaus.groovy."],
  frameworkImportHints: { grails: "grails", "org.grails": "grails", "io.micronaut": "micronaut", "org.springframework.web": "spring-web" },
  frameworkRules: groovyFrameworkRules,
  markerCandidates: ["grails-app"],
};
