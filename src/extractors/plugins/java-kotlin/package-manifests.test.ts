import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import "../../registry.js";
import { parseGradle, parseVersionCatalog } from "./package-manifests.js";
import { collectExternalPackages } from "../../../core/dependency-inventory.js";

const CATALOG = `[versions]
ktor = "2.3.7"
compose-bom = { strictly = "2024.02.00" }

[libraries]
ktor-server-core = { module = "io.ktor:ktor-server-core", version.ref = "ktor" }
ktor-server-netty = { group = "io.ktor", name = "ktor-server-netty", version = { ref = "ktor" } }
compose-bom = { module = "androidx.compose:compose-bom", version.ref = "compose-bom" }
garage-core = "com.example.garage:core:1.4.0"

[bundles]
ktor = [
  "ktor-server-core",
  "ktor-server-netty",
]
`;

const coords = (text: string, catalog: string | null = null, properties: string | null = null) =>
  parseGradle(text, "app/build.gradle.kts", catalog ? parseVersionCatalog(catalog) : null, properties).map((p) => `${p.name}@${p.version ?? ""} ${p.scope}`);

describe("Gradle dependencies", () => {
  it("reads version-catalog accessors, bundles and platforms", () => {
    expect(coords(`dependencies {
    implementation(libs.bundles.ktor)
    implementation(platform(libs.compose.bom))
    testImplementation(libs.garage.core)
}`, CATALOG)).toEqual([
      "io.ktor:ktor-server-core@2.3.7 prod",
      "io.ktor:ktor-server-netty@2.3.7 prod",
      "androidx.compose:compose-bom@2024.02.00 prod",
      "com.example.garage:core@1.4.0 dev",
    ]);
  });

  it("reads the map form, kotlin(x) and a $version from the script or gradle.properties", () => {
    expect(coords(`val exposedVersion = "0.46.0"
dependencies {
    implementation group: 'com.example.league', name: 'fixtures', version: '2.1'
    implementation("org.jetbrains.exposed:exposed-core:$exposedVersion")
    implementation("io.ktor:ktor-client-core:\${ktor_version}")
    implementation(kotlin("reflect"))
}`, null, "ktor_version=2.3.7\n")).toEqual([
      "org.jetbrains.exposed:exposed-core@0.46.0 prod",
      "io.ktor:ktor-client-core@2.3.7 prod",
      "com.example.league:fixtures@2.1 prod",
      "org.jetbrains.kotlin:kotlin-reflect@ prod",
    ]);
  });

  it("finds the build's catalog from a module's build file", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarifydoc-gradle-"));
    try {
      await mkdir(join(root, "gradle"), { recursive: true });
      await mkdir(join(root, "app"), { recursive: true });
      await writeFile(join(root, "gradle", "libs.versions.toml"), CATALOG);
      await writeFile(join(root, "settings.gradle.kts"), `include(":app")`);
      await writeFile(join(root, "app", "build.gradle.kts"), `dependencies {\n    implementation(libs.ktor.server.core)\n}\n`);
      const packages = await collectExternalPackages(root, ["app"]);
      expect(packages.filter((p) => p.ecosystem === "gradle").map((p) => `${p.name}@${p.version}`)).toEqual(["io.ktor:ktor-server-core@2.3.7"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
