import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { javaKotlinFrameworkRules } from "./frameworks.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types + frameworks.ts only.
 */
export const javaManifest: LanguagePluginManifest = {
  language: "java",
  parsing: "tree-sitter",
  extensions: [".java"],
  grammar: { variants: { java: { pkg: "tree-sitter-java", wasm: "tree-sitter-java.wasm" } } },
  testFilePatterns: [/(Test|Tests|IT|ITCase)\.java$/],
  externalModulePrefixes: ["java.", "javax.", "jakarta.", "org.springframework.", "org.apache.", "org.hibernate.", "org.junit.", "io.ktor.", "io.netty.", "com.google.", "com.fasterxml.", "com.amazonaws."],
  externalNamespaceRoots: ["java", "javax", "jakarta", "org", "com", "io"],
  frameworkImportHints: { "io.ktor.server.routing": "ktor", "org.springframework.web.bind.annotation": "spring-web", "org.hibernate": "hibernate", "javax.persistence": "hibernate", "jakarta.persistence": "hibernate", "org.eclipse.persistence": "eclipselink", "org.apache.openjpa": "openjpa", "org.springframework.data.jpa": "spring-data-jpa", "org.springframework.data.jdbc": "spring-data-jdbc", "org.springframework.data.relational": "spring-data-jdbc", "org.mybatis": "mybatis", "org.jooq": "jooq", "org.jetbrains.exposed": "exposed" },
  frameworkRules: javaKotlinFrameworkRules,
  activationFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
};

export const kotlinManifest: LanguagePluginManifest = {
  language: "kotlin",
  parsing: "tree-sitter",
  extensions: [".kt", ".kts"],
  grammar: { variants: { kotlin: { pkg: "tree-sitter-kotlin", wasm: "tree-sitter-kotlin.wasm" } } },
  testFilePatterns: [/(Test|Tests|IT|ITCase)\.kt$/],
  externalModulePrefixes: ["java.", "javax.", "jakarta.", "org.springframework.", "org.apache.", "org.hibernate.", "org.junit.", "io.ktor.", "io.netty.", "com.google.", "com.fasterxml.", "com.amazonaws."],
  externalNamespaceRoots: ["java", "javax", "jakarta", "org", "com", "io"],
  frameworkImportHints: { "io.ktor.server.routing": "ktor", "org.springframework.web.bind.annotation": "spring-web", "org.hibernate": "hibernate", "javax.persistence": "hibernate", "jakarta.persistence": "hibernate", "org.eclipse.persistence": "eclipselink", "org.apache.openjpa": "openjpa", "org.springframework.data.jpa": "spring-data-jpa", "org.springframework.data.jdbc": "spring-data-jdbc", "org.springframework.data.relational": "spring-data-jdbc", "org.mybatis": "mybatis", "org.jooq": "jooq", "org.jetbrains.exposed": "exposed" },
};
