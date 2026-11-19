import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** A config key is joined to the code that reads it: Spring `@Value` / `@ConfigurationProperties`, a Terraform `variable`. */
const SPRING: Record<string, string> = {
  "pom.xml": `<project><modules><module>app</module><module>billing</module></modules></project>
`,
  "app/pom.xml": `<project><artifactId>app</artifactId></project>
`,
  "app/src/test/java/com/example/league/ScoreboardTest.java": `package com.example.league;

import org.springframework.beans.factory.annotation.Value;

public class ScoreboardTest {
    @Value("\${league.testonly}")
    private String t;
}
`,
  "app/src/main/resources/application-prod.yml": `league:
  token: prodtoken
`,
  "app/src/main/resources/application-test.yml": `league:
  testonly: 1
`,
  "app/src/main/resources/application.yml": `league:
  token: abc
  season-length: 38
  unused: 1
  club:
    name: x
    city: y
cup:
  name: z
referee:
  name: a
  fee: 1
  shift: 2
`,
  "app/src/main/java/com/example/league/Scoreboard.java": `package com.example.league;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "league.club")
public class Scoreboard {
    @Value("\${league.token}")
    private String token;

    @Value("\${league.seasonLength:38}")
    private int length;

    @Value("\${LEAGUE_API_KEY}")
    private String apiKey;

    @Value("\${league.testonly}")
    private String t;

    @Value("\${other.thing}")
    private String other;
}
`,
  "app/src/main/java/com/example/league/Referee.java": `package com.example.league;

import java.util.Properties;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

@Component
public class Referee {
    private final Environment env;
    private final Properties props = new Properties();
    private final LeagueSettings settings = new LeagueSettings();

    public String read(Environment local) {
        String a = env.getProperty("referee.name");
        String b = env.getProperty("referee.fee", "x");
        String c = local.getRequiredProperty("referee.shift");
        String d = props.getProperty("cup.name");
        String e = settings.getProperty("cup.name");
        String f = unknown.getProperty("cup.name");
        return a + b + c + d + e + f;
    }
}
`,
  "app/src/main/kotlin/com/example/league/Linesman.kt": `package com.example.league

import org.springframework.core.env.Environment
import org.springframework.stereotype.Component

@Component
class Linesman(private val environment: Environment) {
    fun token(): String? = environment.getProperty("league.token")
}
`,
  "billing/pom.xml": `<project><artifactId>billing</artifactId></project>
`,
  "billing/src/main/resources/application.yml": `league:
  token: other
  billing-only: 1
`,
  "billing/src/main/java/com/example/league/Invoice.java": `package com.example.league;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class Invoice {
    @Value("\${league.billing-only}")
    private String b;
}
`,
  "app/src/main/kotlin/com/example/league/Fixture.kt": `package com.example.league

import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component

@Component
class Fixture(@Value("\\\${league.token}") private val token: String) {
    @Value("\\\${LEAGUE_KICKOFF:19:00}")
    lateinit var kickoff: String

    @Value("""\\\${league.season-length}""")
    var length: Int = 0
}
`,
  "docker-compose.yml": `services:
  app:
    build: ./app
    environment:
      - LEAGUE_TOKEN=x
`,
};

const TERRAFORM: Record<string, string> = {
  "infra/terraform.tfvars": `garage_size = 4
unused_thing = "x"
policy = <<EOT
  car_color = 1
EOT
note = "a # {b"
after_note = 2
/* legacy_size = 3 { */
  "car_color" = 5
`,
  "infra/variables.tf": `variable "garage_size" {
  type = number
}
variable "environment" {}
variable "car_color" {
  default = "red"
}
`,
  "other/variables.tf": `variable "garage_size" {}
`,
};

async function scan(files: Record<string, string>, prefix: string): Promise<{ dir: string; summary: ProjectAnalysis }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "src", rel)), { recursive: true });
    await writeFile(join(dir, "src", rel), text);
  }
  await analyze({ projectRoot: join(dir, "src"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { dir, summary: await loadReportSummary(join(dir, "out")) };
}

describe("Spring configuration keys", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    ({ dir, summary } = await scan(SPRING, "cd-config-spring-"));
  }, 180_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const row = (file: string, key: string) => summary.configKeys!.find((r) => r.file === file && r.key === key);

  it("joins @Value to the key in application.yml, relaxed binding and defaults included", () => {
    expect(row("app/src/main/resources/application.yml", "league.token")!.consumers).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "app/src/main/java/com/example/league/Scoreboard.java", line: 10, via: "value" }),
    ]));
    expect(row("app/src/main/resources/application.yml", "league.season-length")!.consumers).toHaveLength(2);
  });

  it("joins Environment.getProperty on a typed receiver like @Value, and no namesake receiver", () => {
    const consumers = (key: string) => row("app/src/main/resources/application.yml", key)?.consumers.filter((c) => /Referee|Linesman/.test(c.file)) ?? [];
    expect(consumers("referee.name").map((c) => c.file)).toEqual(["app/src/main/java/com/example/league/Referee.java"]);
    expect(consumers("referee.fee").map((c) => c.line)).toEqual([15]);
    expect(consumers("referee.shift").map((c) => c.line)).toEqual([16]);
    expect(consumers("league.token").map((c) => c.file)).toEqual(["app/src/main/kotlin/com/example/league/Linesman.kt"]);
    // Properties, a project class and an untyped receiver read nothing of the configuration.
    expect(consumers("cup.name")).toEqual([]);
  });

  it("reads a Kotlin @Value with an escaped dollar", () => {
    const kotlin = summary.configKeys!.find((r) => r.file === "app/src/main/resources/application.yml" && r.key === "league.token")!.consumers;
    expect(kotlin.map((c) => c.file)).toContain("app/src/main/kotlin/com/example/league/Fixture.kt");
    const raw = summary.configKeys!.find((r) => r.file === "app/src/main/resources/application.yml" && r.key === "league.season-length")!.consumers;
    expect(raw.map((c) => c.file)).toContain("app/src/main/kotlin/com/example/league/Fixture.kt");
    expect(summary.envVars!.find((v) => v.name === "LEAGUE_KICKOFF")!.readBy[0]!.file).toContain("Fixture.kt");
  });

  it("joins a profile file's key, marked with its profile", () => {
    expect(row("app/src/main/resources/application-prod.yml", "league.token")).toMatchObject({ profile: "prod" });
  });

  it("joins @ConfigurationProperties to every key below its prefix, and no other", () => {
    const via = (key: string) => row("app/src/main/resources/application.yml", key)?.consumers.map((c) => c.via);
    expect(via("league.club.name")).toEqual(["prefix"]);
    expect(via("league.club.city")).toEqual(["prefix"]);
    expect(via("cup.name")).toBeUndefined();
    expect(via("league.unused")).toBeUndefined();
  });

  it("keeps a namesake key of another module apart", () => {
    const billing = summary.configKeys!.filter((r) => r.file.startsWith("billing/"));
    expect(billing.map((r) => r.key)).toEqual(["league.billing-only"]);
    expect(billing[0]!.consumers.every((c) => c.file.startsWith("billing/"))).toBe(true);
    const appToken = summary.configKeys!.filter((r) => r.key === "league.token").flatMap((r) => r.consumers);
    expect(appToken.every((c) => c.file.startsWith("app/"))).toBe(true);
  });

  it("lets only test code read a key only a test profile sets", () => {
    const r = row("app/src/main/resources/application-test.yml", "league.testonly")!;
    expect(r.test).toBe(true);
    expect(r.consumers.map((c) => c.file)).toEqual(["app/src/test/java/com/example/league/ScoreboardTest.java"]);
  });

  it("shows an environment-style placeholder in envVars, and a key a deployment sets as its variable", () => {
    expect(summary.envVars!.find((v) => v.name === "LEAGUE_API_KEY")!.readBy[0]!.file).toContain("Scoreboard.java");
    const token = summary.envVars!.find((v) => v.name === "LEAGUE_TOKEN")!;
    expect(token.readBy.map((r) => r.file)).toContain("app/src/main/java/com/example/league/Scoreboard.java");
    expect(token.setBy.length).toBeGreaterThan(0);
  });
});

describe("Terraform variables", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    ({ dir, summary } = await scan(TERRAFORM, "cd-config-tf-"));
  }, 180_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("reads no variable block as an environment variable", () => {
    expect(summary.envVars ?? []).toEqual([]);
  });

  it("joins a tfvars key to the variable block beside it, and not to a namesake in another module", () => {
    expect(summary.configKeys).toEqual([
      // The quoted key on line 9 counts; the one inside the heredoc (line 4) and the block comment do not.
      expect.objectContaining({ key: "car_color", line: 9 }),
      expect.objectContaining({
        key: "garage_size",
        file: "infra/terraform.tfvars",
        line: 1,
        consumers: [expect.objectContaining({ file: "infra/variables.tf", via: "variable" })],
      }),
    ]);
  });
});
