import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasGradleDep, hasMavenDep } from "../shared/project-info-queries.js";

/**
 * JVM framework rules (Spring, Ktor, Quarkus, …, ORMs, Android) via Gradle /
 * Maven build files. Family plugin: attached to `javaMeta` only so the
 * registry aggregates each rule once. Spring Web Flow lives with the
 * springxml plugin (it owns the flow-definition XMLs the rule keys on).
 */
export const javaKotlinFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "spring-boot",
    name: "Spring Boot",
    check: (info) => hasGradleDep(info, "spring-boot") || hasMavenDep(info, "spring-boot"),
    detectedVia: "build file dependency",
  },
  {
    id: "spring-web",
    name: "Spring Web",
    check: (info) => hasGradleDep(info, "spring-web") || hasMavenDep(info, "spring-web"),
    detectedVia: "build file dependency",
  },
  {
    id: "ktor",
    name: "Ktor",
    check: (info) => hasGradleDep(info, "ktor"),
    detectedVia: "build file dependency",
  },
  {
    id: "quarkus",
    name: "Quarkus",
    check: (info) => hasGradleDep(info, "quarkus") || hasMavenDep(info, "quarkus"),
    detectedVia: "build file dependency",
  },
  {
    id: "micronaut",
    name: "Micronaut",
    check: (info) => hasGradleDep(info, "io.micronaut") || hasMavenDep(info, "io.micronaut"),
    detectedVia: "build file dependency",
  },
  {
    id: "jaxrs",
    name: "JAX-RS",
    check: (info) =>
      hasGradleDep(info, "javax.ws.rs") || hasMavenDep(info, "javax.ws.rs") ||
      hasGradleDep(info, "jakarta.ws.rs") || hasMavenDep(info, "jakarta.ws.rs") ||
      hasGradleDep(info, "jersey") || hasMavenDep(info, "jersey") ||
      hasGradleDep(info, "resteasy") || hasMavenDep(info, "resteasy"),
    detectedVia: "build file dependency",
  },
  {
    id: "retrofit",
    name: "Retrofit",
    check: (info) => hasGradleDep(info, "retrofit") || hasMavenDep(info, "retrofit"),
    detectedVia: "build file dependency",
  },
  {
    id: "android",
    name: "Android",
    check: (info) => hasGradleDep(info, "com.android") || hasGradleDep(info, "android"),
    detectedVia: "build file dependency",
  },
  // ORMs
  {
    id: "hibernate",
    name: "Hibernate",
    check: (info) => hasGradleDep(info, "hibernate") || hasMavenDep(info, "hibernate"),
    detectedVia: "build file dependency",
  },
  {
    id: "spring-data-jpa",
    name: "Spring Data JPA",
    check: (info) => hasGradleDep(info, "spring-data-jpa") || hasMavenDep(info, "spring-data-jpa") ||
                     hasGradleDep(info, "spring-boot-starter-data-jpa") || hasMavenDep(info, "spring-boot-starter-data-jpa"),
    detectedVia: "build file dependency",
  },
  {
    id: "mybatis",
    name: "MyBatis",
    check: (info) => hasGradleDep(info, "mybatis") || hasMavenDep(info, "mybatis"),
    detectedVia: "build file dependency",
  },
  {
    id: "jooq",
    name: "jOOQ",
    check: (info) => hasGradleDep(info, "jooq") || hasMavenDep(info, "jooq"),
    detectedVia: "build file dependency",
  },
  {
    id: "exposed",
    name: "Exposed",
    check: (info) => hasGradleDep(info, "org.jetbrains.exposed"),
    detectedVia: "build file dependency",
  },
];
