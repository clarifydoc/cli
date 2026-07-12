import type { KnownPackageRule } from "../../../types/language-plugin.js";

/**
 * JVM package recognition (Maven artifactId / group:artifact, Gradle coords).
 * Shared by the Java + Kotlin metas (Scala benefits via the registry's global
 * name map). Plugin-owned.
 */
export const jvmPackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["spring-boot", "spring-boot-starter", "org.springframework.boot"], category: "framework", framework: { id: "spring-boot", name: "Spring Boot" } },
  { names: ["spring-web", "spring-webmvc"], category: "framework", framework: { id: "spring-web", name: "Spring Web" } },
  { match: /(^|[:/])spring-webflow/, category: "framework", framework: { id: "spring-webflow", name: "Spring Web Flow" } },
  { names: ["micronaut", "micronaut-core"], category: "framework", framework: { id: "micronaut", name: "Micronaut" } },
  { names: ["quarkus", "quarkus-core"], category: "framework", framework: { id: "quarkus", name: "Quarkus" } },
  { names: ["ktor", "ktor-server-core"], category: "framework", framework: { id: "ktor", name: "Ktor" } },
  { names: ["vertx-core", "vertx-web"], category: "framework", framework: { id: "vertx", name: "Vert.x" } },
  { names: ["dropwizard-core"], category: "framework", framework: { id: "dropwizard", name: "Dropwizard" } },
  // ── ORM ──
  { names: ["hibernate-core", "spring-boot-starter-data-jpa", "mybatis", "jooq", "org.jetbrains.exposed"], category: "orm" },
  // ── Messaging ── (exact names win over the spring-boot family pattern below)
  { names: ["spring-boot-starter-amqp", "spring-rabbit", "amqp-client"], category: "messaging", framework: { id: "rabbitmq", name: "RabbitMQ" } },
  { names: ["spring-kafka", "kafka-clients"], category: "messaging", framework: { id: "kafka", name: "Kafka" } },
  { names: ["spring-boot-starter-activemq", "artemis-jms-client"], category: "messaging" },
  // ── Auth ──
  { names: ["spring-boot-starter-security", "spring-security-core"], category: "auth" },
  // ── Testing ──
  { names: ["junit", "junit-jupiter", "mockito-core", "testng", "assertj-core"], category: "testing" },

  // ── Family patterns (lower priority than the exacts above) ──
  // Spring Boot starters/coords (`org.springframework.boot:spring-boot-starter-web`)
  // weren't caught by exact names; the specific data-jpa/security starters above
  // still win (orm/auth) because exact beats pattern.
  { match: /(^|[:/])spring-boot/, category: "framework", framework: { id: "spring-boot", name: "Spring Boot" } },
  { match: /^org\.springframework[.:]/, category: "framework" },
  { match: /(^|[:/])micronaut/, category: "framework", framework: { id: "micronaut", name: "Micronaut" } },
  { match: /(^|[:/])(io\.)?quarkus/, category: "framework", framework: { id: "quarkus", name: "Quarkus" } },
  { match: /(^|[:/.])ktor/, category: "framework", framework: { id: "ktor", name: "Ktor" } },
  { match: /(^|[:/.])(log4j|logback|slf4j)/, category: "logging" },
  { match: /(^|[:/.])jackson/, category: "serialization" },
  { match: /(^|[:/])junit/, category: "testing" },
  { match: /(^|[:/])(mockito|assertj|testng|testcontainers)/, category: "testing" },
];
