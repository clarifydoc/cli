import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-wrapper-hops-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), done: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (summary: ProjectAnalysis, from: string, callName: string): string[] =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => l.targetSymbol).sort();

describe("a hop out of a declared wrapper: Provider.get(), Lazy.value, Lazy.Value, IOptions.Value", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "java/Repos.java": `package com.example.league;
public class ClubRepo { public void save() {} }
class PlayerRepo { public void save() {} }
class Box<T> { public T get() { return null; } }
class Holder { public PlayerRepo get() { return null; } }
`,
      "java/Service.java": `package com.example.league;
import javax.inject.Provider;
public class Service {
  private Provider<ClubRepo> provider;
  private Box<ClubRepo> box;
  private Holder holder;
  public void field() { provider.get().save(); }
  public void viaThis() { this.provider.get().save(); }
  public void param(Provider<ClubRepo> p) { p.get().save(); }
  public void generic() { box.get().save(); }
  public void own() { holder.get().save(); }
}
`,
      "kt/Repos.kt": `package league
class PitchRepo { fun mark() {} }
class StandRepo { fun mark() {} }
class Box<T>(val value: T)
class Holder { val value: StandRepo = StandRepo() }
class Factory {
  val pitchLazy: kotlin.Lazy<PitchRepo> = lazy { PitchRepo() }
  fun lazyPitch(): kotlin.Lazy<PitchRepo> = TODO()
}
`,
      "kt/Pitches.kt": `package league.pitches
class Pitches {
  val declared: kotlin.Lazy<PitchRepo> = lazy { PitchRepo() }
  val box: Box<PitchRepo> = Box(PitchRepo())
  val holder: Holder = Holder()
  fun viaLazy() { declared.value.mark() }
  fun viaBox() { box.value.mark() }
  fun viaHolder() { holder.value.mark() }
  fun midField(factory: Factory) { factory.pitchLazy.value.mark() }
  fun midCall(factory: Factory) { factory.lazyPitch().value.mark() }
}
`,
      "cs/Repos.cs": `namespace League {
  public class ClubRepo { public void Save() {} }
  public class PlayerRepo { public void Save() {} }
  public class ClubSettings { public void Reload() {} }
  public class Box<T> { public T Value { get; } }
  public class Holder { public PlayerRepo Value { get; } }
  public class Settings {
    public IOptionsMonitor<ClubSettings> Monitor { get; }
    public Lazy<ClubRepo> Repo() { return null; }
  }
}
`,
      "cs/Service.cs": `using System;
using Microsoft.Extensions.Options;
namespace League {
  public class Service {
    private readonly Lazy<ClubRepo> _repo;
    private readonly IOptions<ClubSettings> _options;
    private readonly Box<ClubRepo> _box;
    private readonly Holder _holder;
    public void Lazily() { _repo.Value.Save(); }
    public void Options() { _options.Value.Reload(); }
    public void Generic() { _box.Value.Save(); }
    public void Own() { _holder.Value.Save(); }
    public void Mid(Settings s) { s.Monitor.CurrentValue.Reload(); s.Repo().Value.Save(); }
  }
}
`,
    }));
  });
  afterAll(async () => done());

  it("Java: Provider.get() on a field, this.field and a parameter reaches the wrapped class", () => {
    for (const m of ["field", "viaThis", "param"]) expect(targets(summary, `Service.${m}`, m === "viaThis" ? "this.provider.get().save" : m === "param" ? "p.get().save" : "provider.get().save")).toEqual(["ClubRepo.save"]);
  });
  it("Java: a project generic and a project class with their own get() are not unwrapped", () => {
    expect(targets(summary, "Service.generic", "box.get().save")).not.toContain("ClubRepo.save");
    expect(targets(summary, "Service.own", "holder.get().save")).not.toContain("ClubRepo.save");
  });
  it("Kotlin: Lazy.value reaches the wrapped class; Box.value and Holder.value do not", () => {
    expect(targets(summary, "Pitches.viaLazy", "declared.value.mark")).toEqual(["PitchRepo.mark"]);
    expect(targets(summary, "Pitches.viaBox", "box.value.mark")).not.toContain("PitchRepo.mark");
    expect(targets(summary, "Pitches.viaHolder", "holder.value.mark")).toEqual(["StandRepo.mark"]);
    // The wrapper is a field or a method result in the middle of the chain.
    expect(targets(summary, "Pitches.midField", "factory.pitchLazy.value.mark")).toEqual(["PitchRepo.mark"]);
    expect(targets(summary, "Pitches.midCall", "factory.lazyPitch().value.mark")).toEqual(["PitchRepo.mark"]);
  });
  it("C#: Lazy.Value and IOptions.Value reach the wrapped class; Box.Value and Holder.Value do not", () => {
    expect(targets(summary, "Service.Lazily", "_repo.Value.Save")).toEqual(["ClubRepo.Save"]);
    expect(targets(summary, "Service.Options", "_options.Value.Reload")).toEqual(["ClubSettings.Reload"]);
    expect(targets(summary, "Service.Generic", "_box.Value.Save")).not.toContain("ClubRepo.Save");
    expect(targets(summary, "Service.Own", "_holder.Value.Save")).toEqual(["PlayerRepo.Save"]);
    expect(targets(summary, "Service.Mid", "s.Monitor.CurrentValue.Reload")).toEqual(["ClubSettings.Reload"]);
    expect(targets(summary, "Service.Mid", "s.Repo().Value.Save")).toEqual(["ClubRepo.Save"]);
  });
});

describe("a project class named like a wrapper is never unwrapped", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "cs/Types.cs": `namespace League {
  public class ClubRepo { public void Save() {} }
  public class PlayerRepo { public void Save() {} }
  public class Lazy<T> { public PlayerRepo Value { get; } }
}
`,
      "cs/Service.cs": `namespace League {
  public class Service {
    private readonly Lazy<ClubRepo> _repo;
    public void Run() { _repo.Value.Save(); }
  }
}
`,
    }));
  });
  afterAll(async () => done());
  it("C#: the project's own Lazy<T> keeps its declared Value type", () => {
    expect(targets(summary, "Service.Run", "_repo.Value.Save")).not.toContain("ClubRepo.Save");
  });
});

describe("a namesake of a wrapper elsewhere does not stop unwrapping", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "web/package.json": '{"name":"web"}',
      "web/src/provider.ts": "export class Provider<T> { get(): T { return null as any; } }\n",
      "svc/pom.xml": "<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>svc</artifactId><version>1</version></project>",
      "svc/src/main/java/com/example/league/ClubRepo.java": "package com.example.league;\npublic class ClubRepo { public void save() {} }\n",
      "svc/src/main/java/com/example/league/PlayerRepo.java": "package com.example.league;\npublic class PlayerRepo { public void save() {} }\n",
      "svc/src/main/java/com/example/league/Service.java": `package com.example.league;
import javax.inject.Provider;
public class Service {
  private Provider<ClubRepo> provider;
  public void run() { provider.get().save(); }
}
`,
      "pitch/build.gradle.kts": "plugins { kotlin(\"jvm\") }\n",
      "pitch/src/main/kotlin/Pitches.kt": `package league
class PitchRepo { fun mark() {} }
class StandRepo { fun mark() {} }
class Pitches {
  val declared: Lazy<PitchRepo> = lazy { PitchRepo() }
  fun run() { declared.value.mark() }
}
`,
      "other/pom.xml": "<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>other</artifactId><version>1</version></project>",
      "other/src/main/java/Lazy.java": "public class Lazy<T> { public StandRepoLike value; }\nclass StandRepoLike {}\n",
    }));
  });
  afterAll(async () => done());
  it("a TypeScript Provider class does not stop Java's Provider.get()", () => {
    expect(targets(summary, "Service.run", "provider.get().save")).toEqual(["ClubRepo.save"]);
  });
  it("a Java Lazy class in another sub-project does not stop Kotlin's Lazy.value", () => {
    expect(targets(summary, "Pitches.run", "declared.value.mark")).toEqual(["PitchRepo.mark"]);
  });
});

describe("a local holding a wrapper's content, then the call on it", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "java/Repos.java": `package com.example.league;
import java.util.Optional;
public class Club { public void promote() {} }
class Player { public void promote() {} }
class Box<T> { public T get() { return null; } }
public class ClubRepo {
  public Optional<Club> find(int id) { return null; }
  public Box<Club> boxed(int id) { return null; }
  public Player own(int id) { return null; }
}
`,
      "java/Service.java": `package com.example.league;
public class Service {
  private ClubRepo repo;
  public void viaVar() { var c = repo.find(1); c.get().promote(); }
  public void viaBox() { var b = repo.boxed(1); b.get().promote(); }
  public void viaOwn() { var p = repo.own(1); p.promote(); }
}
`,
      "cs/Types.cs": `using System;
using Microsoft.Extensions.Options;
namespace League {
  public class ClubRepo { public void Save() {} }
  public class PlayerRepo { public void Save() {} }
  public class ClubSettings { public void Reload() {} }
  public class PlayerSettings { public void Reload() {} }
  public class Box<T> { public T Value { get; } }
  public class Holder { public PlayerRepo Value { get; } }
}
`,
      "cs/Service.cs": `using System;
using Microsoft.Extensions.Options;
namespace League {
  public class Service {
    private readonly Lazy<ClubRepo> _repo;
    private readonly IOptions<ClubSettings> _options;
    private readonly Box<ClubRepo> _box;
    private readonly Holder _holder;
    public void Options() { var s = _options.Value; s.Reload(); }
    public void Lazily() { var r = this._repo.Value; r.Save(); }
    public void Param(IOptions<ClubSettings> o) { var s = o.Value; s.Reload(); }
    public void Generic() { var b = _box.Value; b.Save(); }
    public void Own() { var h = _holder.Value; h.Save(); }
    public void Twice() { var s = _options.Value; s = _options.Value; s.Reload(); }
  }
}
`,
      "alt/pom.xml": "<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>alt</artifactId><version>1</version></project>",
      "alt/src/main/java/Optional.java": "public class Optional<T> { public PlayerOther get() { return null; } }\nclass PlayerOther { public void promote() {} }\n",
    }));
  });
  afterAll(async () => done());

  it("Java: var c = repo.find(); c.get() takes the Optional's content", () => {
    expect(targets(summary, "Service.viaVar", "c.get().promote")).toEqual(["Club.promote"]);
  });
  it("Java: a project generic and a project return class are not unwrapped", () => {
    expect(targets(summary, "Service.viaBox", "b.get().promote")).not.toContain("Club.promote");
    expect(targets(summary, "Service.viaOwn", "p.promote")).toEqual(["Player.promote"]);
  });
  it("C#: var s = _options.Value (field, this.field, parameter) is the wrapped class", () => {
    expect(targets(summary, "Service.Options", "s.Reload")).toEqual(["ClubSettings.Reload"]);
    expect(targets(summary, "Service.Lazily", "r.Save")).toEqual(["ClubRepo.Save"]);
    expect(targets(summary, "Service.Param", "s.Reload")).toEqual(["ClubSettings.Reload"]);
  });
  it("C#: an unlisted generic's Value and a project class's Value are not unwrapped", () => {
    expect(targets(summary, "Service.Generic", "b.Save")).not.toContain("ClubRepo.Save");
    expect(targets(summary, "Service.Own", "h.Save")).not.toContain("ClubRepo.Save");
  });
  it("C#: a name read twice from the wrapper stays typed (both reads agree)", () => {
    expect(targets(summary, "Service.Twice", "s.Reload")).toEqual(["ClubSettings.Reload"]);
  });
});
