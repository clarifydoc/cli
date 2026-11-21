import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis, Language } from "../../../types/analysis.js";
import { AopAdviceResolver } from "./aop-advice.js";

async function analyze(src: string, rel: string, language: Language = "java"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "aop-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "aop-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

const base = "src/main/java/com/example";
const clubService = (pkg: string) => `package com.example.${pkg};
public class ClubService {
  public String sign(String p, int years) { return p; }
  public void release(String p) { }
  public void idle() { }
}`;
const transfer = `package com.example.league;
public class Transfer {
  @Audited
  public void move() { }
}`;
const audited = `package com.example.league;
public @interface Audited {}`;
const header = `package com.example.aspect;
import org.aspectj.lang.annotation.*;
import org.aspectj.lang.ProceedingJoinPoint;
import com.example.league.Audited;
@Aspect
public class LeagueAspect {
`;

async function edges(aspectBody: string, extra: Array<[string, string]> = []): Promise<string[]> {
  const files = await Promise.all([
    analyze(clubService("league"), `${base}/league/ClubService.java`),
    analyze(clubService("other"), `${base}/other/ClubService.java`),
    analyze(transfer, `${base}/league/Transfer.java`),
    analyze(audited, `${base}/league/Audited.java`),
    analyze(`${header}${aspectBody}\n}`, `${base}/aspect/LeagueAspect.java`),
    ...extra.map(([src, rel]) => analyze(src, rel)),
  ]);
  return new AopAdviceResolver()
    .resolve(files)
    .map((l) => `${l.sourceFile.split("/").slice(-2).join("/")}#${l.sourceSymbol} -> ${l.targetSymbol} ${l.confidence}`)
    .sort();
}

describe("Spring AOP advice on its join points", () => {
  it("links advice to the methods an execution pointcut names, never a namesake in another package", async () => {
    const out = await edges(`
      @Before("execution(* com.example.league.ClubService.*(..))")
      public void checkAuth() { }`);
    expect(out).toEqual([
      "league/ClubService.java#ClubService.idle -> LeagueAspect.checkAuth INFERRED",
      "league/ClubService.java#ClubService.release -> LeagueAspect.checkAuth INFERRED",
      "league/ClubService.java#ClubService.sign -> LeagueAspect.checkAuth INFERRED",
    ]);
  });

  it("follows a named @Pointcut, a text block and the pointcut= attribute", async () => {
    const out = await edges(`
      @Pointcut("execution(* com.example.league..*Service.sign(String, int))")
      public void signing() { }
      @Pointcut(
        """
        signing()
        || execution(* com.example.league.ClubService.release(..))
        """
      )
      public void clubOps() { }
      @AfterReturning(pointcut = "clubOps()", returning = "r")
      public void audit(Object r) { }`);
    expect(out).toEqual([
      "league/ClubService.java#ClubService.release -> LeagueAspect.audit INFERRED",
      "league/ClubService.java#ClubService.sign -> LeagueAspect.audit INFERRED",
    ]);
  });

  it("reads @annotation, a bound annotation parameter, within and negation", async () => {
    const out = await edges(`
      @Around("@annotation(com.example.league.Audited)")
      public Object a(ProceedingJoinPoint pjp) throws Throwable { return pjp.proceed(); }
      @Around("@annotation(audited)")
      public Object b(ProceedingJoinPoint pjp, Audited audited) throws Throwable { return pjp.proceed(); }
      @After("within(com.example.league..*) && !execution(* *.idle(..)) && !@annotation(com.example.league.Audited)")
      public void c() { }`);
    expect(out).toEqual([
      "league/ClubService.java#ClubService.release -> LeagueAspect.c INFERRED",
      "league/ClubService.java#ClubService.sign -> LeagueAspect.c INFERRED",
      "league/Transfer.java#Transfer.move -> LeagueAspect.a INFERRED",
      "league/Transfer.java#Transfer.move -> LeagueAspect.b INFERRED",
    ]);
  });

  it("draws no edge for a class outside the project, an unsupported designator, or an unknown part of an AND", async () => {
    const out = await edges(`
      @Around("execution(* com.example.league.Missing.*(..))")
      public Object ghost(ProceedingJoinPoint pjp) throws Throwable { return pjp.proceed(); }
      @Before("bean(clubService)")
      public void byBean() { }
      @Before("execution(* com.example.league.ClubService.*(..)) && args(String)")
      public void byArgs() { }
      @Before("missingPointcut()")
      public void unnamed() { }
      @Before("execution(* com.example.league.ClubService.sign(..)) || target(java.lang.Object)")
      public void orUnknown() { }`);
    expect(out).toEqual(["league/ClubService.java#ClubService.sign -> LeagueAspect.orUnknown INFERRED"]);
  });

  it("reaches an implementation through the interface the pointcut names", async () => {
    const out = await edges(
      `
      @Before("execution(* com.example.league.Roster.add(..))")
      public void audit() { }`,
      [
        [`package com.example.league;\npublic interface Roster { void add(String p); }`, `${base}/league/Roster.java`],
        [`package com.example.league;\npublic class HomeRoster implements Roster { public void add(String p) { } public void other() { } }`, `${base}/league/HomeRoster.java`],
      ],
    );
    expect(out).toEqual(["league/HomeRoster.java#HomeRoster.add -> LeagueAspect.audit INFERRED", "league/Roster.java#Roster.add -> LeagueAspect.audit INFERRED"]);
  });

  it("matches `..` as whole segments, and a long pathological pattern finishes at once", async () => {
    const out = await edges(`
      @Before("execution(* com.example..ClubService.sign(..))")
      public void whole() { }
      @Before("execution(* com.exam..ClubService.sign(..))")
      public void partial() { }`);
    expect(out.map((e) => e.split(" -> ")[1])).toEqual(["LeagueAspect.whole INFERRED", "LeagueAspect.whole INFERRED"]);
    const long = `${"a..".repeat(300)}z`;
    const started = Date.now();
    const slow = await edges(`
      @Before("execution(* ${long}.ClubService.sign(..)) || within(${long}.*)")
      public void slow() { }`);
    expect(slow).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("skips private methods, resolves a wildcard-imported annotation, and never turns a guess into a negation", async () => {
    const out = await edges(
      `
      @Before("within(com.example.league.Bench) && !@annotation(audited)")
      public void guarded(Audited audited) { }
      @Before("within(com.example.league.Bench) && !@annotation(ghost)")
      public void unresolved(Ghost ghost) { }`,
      [[`package com.example.league;\npublic class Bench { public void sit() { } private void hide() { } @Audited public void audit() { } }`, `${base}/league/Bench.java`]],
    );
    // `Audited` is in the aspect's explicit import; `Ghost` is no project type, so the negation says nothing.
    expect(out).toEqual(["league/Bench.java#Bench.sit -> LeagueAspect.guarded INFERRED"]);
  });

  it("reads a Kotlin import alias as its type, and a static import as a member, never a type", async () => {
    const aliased = await analyze(`package com.example.aspect
import com.example.league.ClubService as Roster
import org.aspectj.lang.annotation.Aspect
import org.aspectj.lang.annotation.Before
@Aspect
class LeagueAspect {
  @Before("within(Roster)")
  fun checkAuth() { }
}`, `src/main/kotlin/com/example/aspect/LeagueAspect.kt`, "kotlin");
    const service = await analyze(clubService("league"), `${base}/league/ClubService.java`);
    const resolved = new AopAdviceResolver().resolve([aliased, service]).map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`).sort();
    expect(resolved).toEqual(["ClubService.idle -> LeagueAspect.checkAuth", "ClubService.release -> LeagueAspect.checkAuth", "ClubService.sign -> LeagueAspect.checkAuth"]);

    // `ClubService` here is a static member of Helper: the negation must stay unknown, not become true.
    const statics = await analyze(`package com.example.aspect;
import static com.example.other.Helper.ClubService;
import org.aspectj.lang.annotation.*;
@Aspect
public class LeagueAspect {
  @Before("!within(ClubService)")
  public void checkAuth() { }
}`, `${base}/aspect/LeagueAspect.java`);
    expect(new AopAdviceResolver().resolve([statics, service])).toEqual([]);
  });
});
