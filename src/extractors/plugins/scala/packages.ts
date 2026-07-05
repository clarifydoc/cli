import type { KnownPackageRule } from "../../../types/language-plugin.js";

/**
 * Scala (sbt) package recognition. sbt resolves Maven coordinates, so these are
 * matched by artifactId or `group:artifact` (and the JVM plugin's jvmPackages
 * still apply to Spring/etc. via the registry's global map).
 */
export const scalaPackages: readonly KnownPackageRule[] = [
  { names: ["play", "play-server", "twirl-api"], category: "framework", framework: { id: "play", name: "Play Framework" } },
  { names: ["zio", "zio-http"], category: "framework", framework: { id: "zio", name: "ZIO" } },
  { match: /(^|[:/])akka-/, category: "framework", framework: { id: "akka", name: "Akka" } },
  { match: /(^|[:/])http4s/, category: "framework", framework: { id: "http4s", name: "http4s" } },
  { names: ["cats", "cats-core", "cats-effect"], category: "util" },
  { names: ["circe", "circe-core", "spray-json", "play-json", "upickle"], category: "serialization" },
  { names: ["slick", "doobie", "quill"], category: "orm" },
  { names: ["scalatest", "specs2", "munit", "scalacheck"], category: "testing" },
];
