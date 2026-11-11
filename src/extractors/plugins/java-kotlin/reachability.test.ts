import { describe, it, expect } from "vitest";
import { javaKotlinReachability } from "./reachability.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const analysis = (filePath: string, cls: Record<string, unknown>): FileAnalysis =>
  ({ filePath, classes: [{ extends: null, implements: [], decorators: [], methods: [], ...cls }], functions: [], routes: [] }) as unknown as FileAnalysis;
const none = new Set<string>();

describe("Java/Kotlin reachability — what a container or a code generator loads", () => {
  it("keeps servlet initializers and Glide modules alive", async () => {
    const m = await javaKotlinReachability.load({ projectRoot: "/nonexistent", roots: [], files: new Set<string>() });
    const passive = (a: FileAnalysis) => m.passiveReason!(a, a.filePath, none);
    expect(passive(analysis("WebInit.java", { name: "WebInit", implements: ["WebApplicationInitializer"] }))).toMatch(/WebApplicationInitializer/);
    expect(passive(analysis("Dispatcher.java", { name: "Dispatcher", extends: "AbstractAnnotationConfigDispatcherServletInitializer" }))).toMatch(/Initializer/);
    expect(passive(analysis("MyGlide.java", { name: "MyGlide", extends: "AppGlideModule", decorators: ["GlideModule"] }))).not.toBeNull();
    expect(passive(analysis("Orphan.java", { name: "Orphan" }))).toBeNull();
  });
});

describe("Java/Kotlin reachability — the author's own word", () => {
  it("keeps a declaration suppressed as unused alive", async () => {
    const m = await javaKotlinReachability.load({ projectRoot: "/nonexistent", roots: [], files: new Set<string>() });
    expect(m.passiveReason!(analysis("K.kt", { name: "K", decorators: ['Suppress("unused")'] }), "K.kt", none)).not.toBeNull();
    expect(m.passiveReason!(analysis("J.java", { name: "J", decorators: ['SuppressWarnings({"unused", "rawtypes"})'] }), "J.java", none)).not.toBeNull();
    expect(m.passiveReason!(analysis("U.java", { name: "U", decorators: ['SuppressWarnings("unchecked")'] }), "U.java", none)).toBeNull();
  });
});

describe("Java/Kotlin reachability — classes a framework loads by name", () => {
  it("keeps Camel route builders, JAX-WS services and Anvil contributions alive", async () => {
    const m = await javaKotlinReachability.load({ projectRoot: "/nonexistent", roots: [], files: new Set<string>() });
    const passive = (a: FileAnalysis) => m.passiveReason!(a, a.filePath, none);
    expect(passive(analysis("ClubRoutes.java", { name: "ClubRoutes", extends: "RouteBuilder" }))).toMatch(/RouteBuilder/);
    expect(passive(analysis("MatchRoutes.kt", { name: "MatchRoutes", extends: "RouteBuilder()" }))).toMatch(/RouteBuilder/);
    expect(passive(analysis("ClubService.java", { name: "ClubService", decorators: ['WebService(serviceName = "ClubService")'] }))).toMatch(/WebService/);
    expect(passive(analysis("ClubProvider.java", { name: "ClubProvider", decorators: ["WebServiceProvider"] }))).toMatch(/WebServiceProvider/);
    for (const dec of ["ContributesBinding(AppScope::class)", "ContributesTo(AppScope::class)", "ContributesMultibinding(AppScope::class)"]) {
      expect(passive(analysis("RealClubRepository.kt", { name: "RealClubRepository", decorators: [dec] })), dec).not.toBeNull();
    }
  });

  it("keeps classes a ProGuard keep rule names, a package wildcard keeping the package", async () => {
    const root = mkdtempSync(join(tmpdir(), "proguard-"));
    try {
      mkdirSync(join(root, "app"), { recursive: true });
      writeFileSync(
        join(root, "app/proguard-rules.pro"),
        [
          "-keepattributes Signature, *Annotation*",
          "-keep class com.example.league.Club",
          "-keep public class com.example.league.dto.** { *; }",
          "-keep class com.example.league.api.* { *; }",
          "-keepclassmembers class com.example.league.Referee { *; }",
          "-keep public class * extends android.app.Activity",
          "-dontwarn okhttp3.**",
        ].join("\n"),
      );
      const src = "app/src/main/java/com/example/league";
      const m = await javaKotlinReachability.load({ projectRoot: root, roots: ["app"], files: new Set<string>() });
      const passive = (path: string, name: string) => m.passiveReason!(analysis(path, { name }), path.slice("app/".length), none);
      expect(passive(`${src}/Club.java`, "Club")).toMatch(/ProGuard/);
      expect(passive(`${src}/dto/PlayerDto.kt`, "PlayerDto")).toMatch(/ProGuard/);
      expect(passive(`${src}/dto/stats/GoalDto.java`, "GoalDto")).toMatch(/ProGuard/);
      expect(passive(`${src}/api/ClubApi.java`, "ClubApi")).toMatch(/ProGuard/);
      // `*` is one package level; `-keepclassmembers` keeps no class; `class *` names no class.
      expect(passive(`${src}/api/v2/ClubApiV2.java`, "ClubApiV2")).toBeNull();
      expect(passive(`${src}/Referee.java`, "Referee")).toBeNull();
      expect(passive(`${src}/Stadium.java`, "Stadium")).toBeNull();
      expect(passive(`${src}/ClubExtra.java`, "ClubExtra")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Java/Kotlin reachability — Spring auto-configuration lists", () => {
  it("keeps a class listed in META-INF/spring/*.AutoConfiguration.imports or spring.factories", async () => {
    const root = mkdtempSync(join(tmpdir(), "autoconfig-"));
    try {
      mkdirSync(join(root, "src/main/resources/META-INF/spring"), { recursive: true });
      writeFileSync(
        join(root, "src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports"),
        "com.example.league.GarageAutoConfiguration\n",
      );
      writeFileSync(join(root, "src/main/resources/META-INF/spring.factories"), "x.EnableAutoConfiguration=com.example.league.ClubAutoConfiguration\n");
      const m = await javaKotlinReachability.load({ projectRoot: root, roots: [], files: new Set<string>() });
      expect(m.configMentions?.has("GarageAutoConfiguration")).toBe(true);
      expect(m.configMentions?.has("ClubAutoConfiguration")).toBe(true);
      expect(m.configMentions?.has("MatchOrphan")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
