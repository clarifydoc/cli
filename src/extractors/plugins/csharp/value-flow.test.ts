/**
 * C# value-flow facts through the real per-file pipeline and the linker: a method group or delegate travelling
 * through locals, parameters, fields, properties, events, returns and collections to the call that runs it.
 * Every case keeps a same-named decoy a name tier (or an unrelated type's `Invoke`) would grab.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis, SubProject } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>, projectOf: (rel: string) => string = () => "root"): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "cs-vf-"));
  const out = await mkdtemp(join(tmpdir(), "cs-vf-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "csharp" },
      frameworkIds: [],
      projectId: projectOf(rel),
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

/** `source@line -> target`, for the value-flow links only. */
function flowLinks(analyses: FileAnalysis[], subProjects: SubProject[] = []): string[] {
  return buildSymbolLinks(analyses, subProjects)
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

const lines = (...l: string[]) => l.join("\n") + "\n";

describe("C# value flow: locals, parameters and wrappers", () => {
  const files = {
    "League/Club.cs": lines(
      "namespace League;",
      "public class Club {",
      "  public void Save() {}",
      "  public void Load() {}",
      "  public void Wire() {",
      "    Action a = Save;",
      "    Action b = a;",
      "    Run(b);",
      "  }",
      "  void Run(Action cb) {",
      "    cb();",
      "  }",
      "  public void Direct() {",
      "    Run(Load);",
      "  }",
      "  public void Chosen(bool lazy) {",
      "    Func<int> g = lazy ? Count : Total;",
      "    g.Invoke();",
      "  }",
      "  int Count() => 1;",
      "  int Total() => 2;",
      "}",
    ),
    // The decoys: an unrelated class with the same method names and an `Invoke` of its own.
    "League/Decoy.cs": lines(
      "namespace League;",
      "public class Decoy {",
      "  public void Save() {}",
      "  public void Load() {}",
      "  public void cb() {}",
      "  public void Invoke() {}",
      "}",
    ),
  };

  it("follows a method group through a local, a copy, a wrapper's parameter and Invoke", async () => {
    const links = flowLinks(await analyzeAll(files));
    expect(links).toContain("Club.Run@11 cb -> League/Club.cs::Club.Save");
    expect(links).toContain("Club.Run@11 cb -> League/Club.cs::Club.Load");
    expect(links.filter((l) => l.includes("Decoy"))).toEqual([]);
  });

  it("takes both arms of a conditional and runs them through .Invoke()", async () => {
    const links = flowLinks(await analyzeAll(files));
    expect(links).toContain("Club.Chosen@18 g.Invoke -> League/Club.cs::Club.Count");
    expect(links).toContain("Club.Chosen@18 g.Invoke -> League/Club.cs::Club.Total");
  });
});

describe("C# value flow: fields, properties, factories", () => {
  const files = {
    "League/Match.cs": lines(
      "namespace League;",
      "public delegate void Whistle(string who);",
      "public class Match {",
      "  private Action _onClose;",
      "  private readonly Action _started = Kickoff;",
      "  public Whistle Referee { get; set; }",
      "  public void Kickoff() {}",
      "  public void Close() {}",
      "  public void FullTime(string who) {}",
      "  public void Arm() {",
      "    _onClose = Close;",
      "    this.Referee = FullTime;",
      "  }",
      "  public void Fire() {",
      "    _onClose();",
      "    Referee(\"x\");",
      "  }",
      "  public Action Factory() => Kickoff;",
      "  public void UseFactory() {",
      "    var f = Factory();",
      "    f();",
      "  }",
      "  public Match() {}",
      "  public void Late() {",
      "    _started.Invoke();",
      "  }",
      "}",
    ),
    "League/Decoy.cs": lines(
      "namespace League;",
      "public class Decoy {",
      "  public void _onClose() {}",
      "  public void Referee(string who) {}",
      "  public void f() {}",
      "  public void Invoke() {}",
      "}",
    ),
  };

  it("runs what a field, a property and a factory hold", async () => {
    const links = flowLinks(await analyzeAll(files));
    expect(links).toContain("Match.Fire@15 _onClose -> League/Match.cs::Match.Close");
    expect(links).toContain("Match.Fire@16 Referee -> League/Match.cs::Match.FullTime");
    expect(links).toContain("Match.UseFactory@21 f -> League/Match.cs::Match.Kickoff");
    expect(links).toContain("Match.Late@25 _started.Invoke -> League/Match.cs::Match.Kickoff");
    expect(links.filter((l) => l.includes("Decoy"))).toEqual([]);
  });
});

describe("C# value flow: events", () => {
  const files = {
    "League/Referee.cs": lines(
      "namespace League;",
      "public class Referee {",
      "  public event EventHandler Whistled;",
      "  public void Blow() {",
      "    Whistled?.Invoke(this, EventArgs.Empty);",
      "  }",
      "  public void BlowTwice() {",
      "    Whistled(this, EventArgs.Empty);",
      "  }",
      "}",
    ),
    "League/Fan.cs": lines(
      "namespace League;",
      "public class Fan {",
      "  public void OnWhistled(object s, EventArgs e) {}",
      "  public void Watch(Referee r) {",
      "    r.Whistled += OnWhistled;",
      "  }",
      "}",
    ),
    "League/Stadium.cs": lines(
      "namespace League;",
      "public class Stadium {",
      "  public event EventHandler Whistled;",
      "  public void OnWhistled(object s, EventArgs e) {}",
      "  public void Hush() { Whistled?.Invoke(this, null); }",
      "}",
    ),
    "League/Decoy.cs": lines(
      "namespace League;",
      "public class Decoy {",
      "  public void Invoke(object s, EventArgs e) {}",
      "  public void Hear(Decoy d) { d.Invoke(null, null); }",
      "}",
    ),
  };

  it("joins a subscription on a typed receiver to the raise inside the declaring class only", async () => {
    const links = flowLinks(await analyzeAll(files));
    expect(links).toContain("Referee.Blow@5 Whistled?.Invoke -> League/Fan.cs::Fan.OnWhistled");
    expect(links).toContain("Referee.BlowTwice@8 Whistled -> League/Fan.cs::Fan.OnWhistled");
    // Another class's event of the same name is another cell: nothing subscribed to it.
    expect(links.filter((l) => l.startsWith("Stadium.Hush"))).toEqual([]);
    expect(links.filter((l) => l.includes("Decoy"))).toEqual([]);
  });
});

describe("C# value flow: collections of handlers", () => {
  const files = {
    "League/Bus.cs": lines(
      "namespace League;",
      "public class Bus {",
      "  private readonly Dictionary<string, Action> _handlers = new() { [\"open\"] = Open };",
      "  private readonly List<Func<int>> _counters = new();",
      "  public void Open() {}",
      "  public void Close() {}",
      "  public int Goals() => 1;",
      "  public void Register() {",
      "    _handlers[\"close\"] = Close;",
      "    _counters.Add(Goals);",
      "  }",
      "  public void Dispatch(string key) {",
      "    _handlers[key]();",
      "    foreach (var c in _counters) c();",
      "  }",
      "  public void Local() {",
      "    var table = new Dictionary<string, Action>();",
      "    table.Add(\"a\", Open);",
      "    if (table.TryGetValue(\"a\", out var h)) h();",
      "    var list = new List<Action> { Close };",
      "    list[0]();",
      "  }",
      "}",
    ),
    "League/Decoy.cs": lines(
      "namespace League;",
      "public class Decoy {",
      "  public void h() {}",
      "  public void c() {}",
      "}",
    ),
  };

  it("runs a handler by key, by element and through a loop", async () => {
    const links = flowLinks(await analyzeAll(files));
    expect(links).toContain("Bus.Dispatch@13 _handlers[] -> League/Bus.cs::Bus.Open");
    expect(links).toContain("Bus.Dispatch@13 _handlers[] -> League/Bus.cs::Bus.Close");
    expect(links).toContain("Bus.Dispatch@14 c -> League/Bus.cs::Bus.Goals");
    expect(links).toContain("Bus.Local@19 h -> League/Bus.cs::Bus.Open");
    expect(links).toContain("Bus.Local@21 list[] -> League/Bus.cs::Bus.Close");
    expect(links.filter((l) => l.includes("Decoy"))).toEqual([]);
  });
});

describe("C# value flow: no link without a held function", () => {
  it("leaves an ordinary Invoke method and a parameter delegate alone; a lambda local stands for what it calls", async () => {
    const files = {
      "League/Plain.cs": lines(
        "namespace League;",
        "public class Plain {",
        "  public void Invoke() {}",
        "  public void Save() {}",
        "  public void Go(Plain p, Action cb) {",
        "    p.Invoke();",
        "    Action a = () => Save();",
        "    a();",
        "    cb();",
        "  }",
        "}",
      ),
    };
    const links = flowLinks(await analyzeAll(files));
    // `a()` runs the lambda `() => Save()`; `cb()` (a parameter nothing hands a function) and `p.Invoke()` link nothing.
    expect(links).toEqual(["Plain.Go@8 a -> League/Plain.cs::Plain.Save"]);
  });
});

describe("C# value flow: a constructor stores what it is handed", () => {
  const files = {
    "League/Button.cs": lines(
      "namespace League;",
      "public class Button {",
      "  private readonly Action _onClick;",
      "  public Button(Action onClick) { _onClick = onClick; }",
      "  public void Press() { _onClick(); }",
      "}",
    ),
    "League/Menu.cs": lines(
      "namespace League;",
      "public class Menu {",
      "  public void Start() {}",
      "  public void Build() {",
      "    var b = new Button(Start);",
      "    b.Press();",
      "  }",
      "}",
    ),
    "League/Decoy.cs": lines("namespace League;", "public class Decoy {", "  public void _onClick() {}", "  public void Start() {}", "}"),
  };

  it("runs the method group a `new Button(Start)` handed to the field", async () => {
    const links = flowLinks(await analyzeAll(files));
    expect(links).toContain("Button.Press@5 _onClick -> League/Menu.cs::Menu.Start");
    expect(links.filter((l) => l.includes("Decoy"))).toEqual([]);
  });
});

describe("C# value flow: lambdas as values", () => {
  const files = {
    "League/Club.cs": lines("namespace League;", "public class Club {", "  public void Save() {}", "}"),
    "League/Match.cs": lines(
      "namespace League;",
      "public class Match {",
      "  private Action _onDone;",
      "  private readonly Action _kick = () => KickOff();",
      "  private readonly Dictionary<string, Action> _handlers = new();",
      "  public void KickOff() {}",
      "  public void CloseMatch() {}",
      "  public void RefreshTable() {}",
      "  public void Wire(Club club) {",
      "    Action a = () => club.Save();",
      "    WrapIt(a);",
      "    _onDone = () => RefreshTable();",
      "    _handlers[\"close\"] = () => CloseMatch();",
      "    Action chained = () => _onDone();",
      "    chained();",
      "    var v = () => this.KickOff();",
      "    v.Invoke();",
      "  }",
      "  public void WrapIt(Action w) { w(); }",
      "  public void Finish() { _onDone(); _kick(); }",
      "  public void Dispatch() { _handlers[\"close\"](); }",
      "  public Action Factory() { return () => CloseMatch(); }",
      "  public Func<int> Counter() => () => { CloseMatch(); return 1; };",
      "  public void Use() { var f = Factory(); f(); }",
      "  public void Many() { Action m = () => { KickOff(); CloseMatch(); RefreshTable(); Wire(null); Finish(); }; m(); }",
      "  public void Pair() { Action p = () => { KickOff(); CloseMatch(); }; p(); }",
      "  public void ViaParam() { Action<Club> c = x => x.Save(); c(null); }",
      "  public void Made() { Action t = () => new Club(); t(); }",
      "  public void Wrap() { Action<Action> wr = cb => cb(); wr(null); }",
      "  public void Quiet() { Action q = () => Console.WriteLine(\"x\"); q(); }",
      "}",
    ),
    "League/Decoy.cs": lines(
      "namespace League;",
      "public class Decoy {",
      "  public void KickOff() {}",
      "  public void CloseMatch() {}",
      "  public void RefreshTable() {}",
      "  public void Save() {}",
      "  public void Invoke() {}",
      "  public void w() {}",
      "  public void a() {}",
      "  public void cb() {}",
      "}",
    ),
  };

  it("makes a lambda stand for the functions its body calls", async () => {
    const links = flowLinks(await analyzeAll(files));
    expect(links).toEqual([
      // a local lambda handed to a wrapper that runs its parameter
      "Match.WrapIt@19 w -> League/Club.cs::Club.Save",
      // a lambda assigned to a field, a field initializer, an element read by key
      "Match.Wire@14 _onDone -> League/Match.cs::Match.RefreshTable",
      "Match.Finish@20 _onDone -> League/Match.cs::Match.RefreshTable",
      "Match.Finish@20 _kick -> League/Match.cs::Match.KickOff",
      "Match.Dispatch@21 _handlers[] -> League/Match.cs::Match.CloseMatch",
      // a factory's lambda, run by its caller
      "Match.Use@24 f -> League/Match.cs::Match.CloseMatch",
      // a lambda that runs a held delegate holds what it holds
      "Match.Wire@15 chained -> League/Match.cs::Match.RefreshTable",
      "Match.Wire@17 v.Invoke -> League/Match.cs::Match.KickOff",
      // two calls are both seeded
      "Match.Pair@26 p -> League/Match.cs::Match.CloseMatch",
      "Match.Pair@26 p -> League/Match.cs::Match.KickOff",
    ].sort());
    // Five calls, a call on the lambda's own parameter, a construction and a platform call state nothing.
    expect(links.filter((l) => /^Match\.(Many|ViaParam|Made|Quiet|Wrap)@/.test(l))).toEqual([]);
    expect(links.filter((l) => l.includes("Decoy"))).toEqual([]);
  });

  it("counts only the project functions a lambda resolves to: library and unknown calls never use up the four", async () => {
    const capFiles = {
      "League/Squad.cs": lines(
        "namespace League;",
        "public class Squad {",
        "  private readonly ILogger _logger;",
        "  public void PickKeeper() {}",
        "  public void PickDefender() {}",
        "  public void PickMidfielder() {}",
        "  public void PickStriker() {}",
        "  public void PickCaptain() {}",
        "  public void Four(List<int> list, Helper helper) {",
        "    Action a = () => { Console.WriteLine(\"x\"); _logger.LogInformation(\"y\"); list.Add(1); helper.Frobnicate(); PickKeeper(); PickDefender(); PickMidfielder(); PickStriker(); };",
        "    a();",
        "  }",
        "  public void Five() {",
        "    Action b = () => { Console.WriteLine(\"x\"); PickKeeper(); PickDefender(); PickMidfielder(); PickStriker(); PickCaptain(); };",
        "    b();",
        "  }",
        "}",
      ),
      "League/Decoy.cs": lines(
        "namespace League;",
        "public class Decoy {",
        "  public void PickKeeper() {}",
        "  public void PickDefender() {}",
        "  public void PickMidfielder() {}",
        "  public void PickStriker() {}",
        "  public void PickCaptain() {}",
        "  public void Frobnicate() {}",
        "  public void a() {}",
        "  public void b() {}",
        "}",
      ),
    };
    const links = flowLinks(await analyzeAll(capFiles));
    expect(links).toEqual([
      "Squad.Four@11 a -> League/Squad.cs::Squad.PickDefender",
      "Squad.Four@11 a -> League/Squad.cs::Squad.PickKeeper",
      "Squad.Four@11 a -> League/Squad.cs::Squad.PickMidfielder",
      "Squad.Four@11 a -> League/Squad.cs::Squad.PickStriker",
    ].sort());
    expect(links.filter((l) => l.includes("Five") || l.includes("Decoy"))).toEqual([]);
  });

  it("joins a lambda subscribed to an event to the raise inside the declaring class", async () => {
    const withEvent = {
      "League/Referee.cs": lines(
        "namespace League;",
        "public class Referee {",
        "  public event Action Whistled;",
        "  public void Raise() { Whistled?.Invoke(); }",
        "}",
      ),
      "League/Bench.cs": lines(
        "namespace League;",
        "public class Bench {",
        "  public void Substitute() {}",
        "  public void Listen(Referee r) { r.Whistled += () => Substitute(); }",
        "}",
      ),
      "League/Other.cs": lines(
        "namespace League;",
        "public class Other {",
        "  public event Action Whistled;",
        "  public void Raise() { Whistled?.Invoke(); }",
        "  public void Substitute() {}",
        "}",
      ),
    };
    const links = flowLinks(await analyzeAll(withEvent));
    expect(links).toEqual(["Referee.Raise@4 Whistled?.Invoke -> League/Bench.cs::Bench.Substitute"]);
  });
});

describe("C# value flow: named arguments", () => {
  const files = {
    "League/Clock.cs": lines(
      "namespace League;",
      "public class Clock {",
      "  public void OnFullTime() { }",
      "  public void OnKickOff() { }",
      "  public void Schedule(System.Action when, System.Action callback) { callback(); }",
      "  public void ByName() { Schedule(callback: OnFullTime, when: OnKickOff); }",
      "  public void UnknownName() { Schedule(missing: OnKickOff, callback: OnFullTime); }",
      "}",
    ),
  };
  it("binds a named argument to the formal of that name, never by position", async () => {
    const links = flowLinks(await analyzeAll(files));
    expect(links.some((l) => l.includes("callback") && l.endsWith("Clock.OnFullTime"))).toBe(true);
    expect(links.some((l) => l.includes("callback") && l.endsWith("Clock.OnKickOff"))).toBe(false);
  });
});

describe("C# value flow: leftovers", () => {
  it("knows a delegate type another file declares", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Notify.cs": lines("namespace League;", "public delegate void Notify(string who);"),
      "League/Club.cs": lines(
        "namespace League;",
        "public class Club {",
        "  public void Save(string who) {}",
        "  public void Wire() { Run(Save); }",
        "  void Run(Notify cb) {",
        "    cb(\"x\");",
        "  }",
        "}",
      ),
      "League/Decoy.cs": lines("namespace League;", "public class Decoy { public void Save(string who) {} public void Run(Decoy d) { d.Save(\"x\"); } }"),
    }));
    expect(links).toContain("Club.Run@6 cb -> League/Club.cs::Club.Save");
    expect(links.filter((l) => l.includes("Decoy"))).toEqual([]);
  });

  it("does not take a project class named like a delegate as one", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Notify.cs": lines("namespace League;", "public class Notify { public void Send(string who) {} }"),
      "League/Club.cs": lines(
        "namespace League;",
        "public class Club {",
        "  public void Save(string who) {}",
        "  public void Wire() { Run(null); }",
        "  void Run(Notify cb) { cb.Send(\"x\"); }",
        "}",
      ),
    }));
    expect(links).toEqual([]);
  });

  it("joins a subscription through a derived variable to the raise in the base class", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Referee.cs": lines(
        "namespace League;",
        "public class Referee {",
        "  public event Action Whistled;",
        "  public void Blow() { Whistled?.Invoke(); }",
        "}",
        "public class LineReferee : Referee { }",
      ),
      "League/Fan.cs": lines(
        "namespace League;",
        "public class Fan {",
        "  public void Cheer() {}",
        "  public void Watch(LineReferee r) { r.Whistled += Cheer; }",
        "}",
      ),
      "League/Stadium.cs": lines(
        "namespace League;",
        "public class Stadium {",
        "  public event Action Whistled;",
        "  public void Cheer() {}",
        "  public void Hush() { Whistled?.Invoke(); }",
        "}",
      ),
    }));
    expect(links).toContain("Referee.Blow@4 Whistled?.Invoke -> League/Fan.cs::Fan.Cheer");
    expect(links.filter((l) => l.startsWith("Stadium."))).toEqual([]);
  });

  it("states an argument fact for each of two calls of one name in a member", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Club.cs": lines(
        "namespace League;",
        "public class Club {",
        "  public void Save() {}",
        "  public void Load() {}",
        "  public void Wire() {",
        "    Run(Save);",
        "    Run(Load);",
        "  }",
        "  void Run(Action cb) { cb(); }",
        "}",
      ),
    }));
    expect(links).toContain("Club.Run@9 cb -> League/Club.cs::Club.Save");
    expect(links).toContain("Club.Run@9 cb -> League/Club.cs::Club.Load");
  });

  it("joins a subscription through an interface that declares the event to the raise in its implementer, not in a namesake", async () => {
    const links = flowLinks(await analyzeAll({
      "League/IReferee.cs": lines("namespace League;", "public interface IReferee {", "  event Action Whistled;", "}"),
      "League/Referee.cs": lines(
        "namespace League;",
        "public class Referee : IReferee {",
        "  public event Action Whistled;",
        "  public void Blow() { Whistled?.Invoke(); }",
        "}",
        "public class Linesman : IReferee {",
        "  public event Action Whistled;",
        "  public void Flag() { Whistled?.Invoke(); }",
        "}",
      ),
      "League/Fan.cs": lines(
        "namespace League;",
        "public class Fan {",
        "  public void Cheer() {}",
        "  public void Watch(IReferee r) { r.Whistled += Cheer; }",
        "}",
      ),
      "League/Coach.cs": lines(
        "namespace League;",
        "public class Coach {",
        "  public void Listen() {}",
        "  public void Watch(Linesman l) { l.Whistled += Listen; }",
        "}",
      ),
    }));
    expect(links).toContain("Referee.Blow@4 Whistled?.Invoke -> League/Fan.cs::Fan.Cheer");
    // A handler subscribed on the concrete namesake is not run by the other implementer's raise.
    expect(links.filter((l) => l.startsWith("Referee.Blow") && l.includes("Coach"))).toEqual([]);
    expect(links).toContain("Linesman.Flag@8 Whistled?.Invoke -> League/Coach.cs::Coach.Listen");
  });
});

describe("C# value flow: delegate types declared in another file", () => {
  const delegateFile = { "League/Delegates.cs": lines("namespace League;", "public delegate void ClubAction(string club);") };

  it("follows a handler through a field and a parameter typed by a delegate another file declares", async () => {
    const links = flowLinks(await analyzeAll({
      ...delegateFile,
      "League/Registry.cs": lines(
        "namespace League;",
        "public class Registry {",
        "  private ClubAction _onSigned;",
        "  public void Subscribe(ClubAction cb) { _onSigned = cb; }",
        "  public void Fire(string c) { _onSigned(c); }",
        "  public void Run(ClubAction cb, string c) { cb(c); }",
        "}",
      ),
      "League/Main.cs": lines(
        "namespace League;",
        "public class Main {",
        "  public void Wire(Registry r) { r.Subscribe(Handle); r.Run(Other, \"x\"); }",
        "  public void Handle(string club) {}",
        "  public void Other(string club) {}",
        "  public void Decoy(string club) {}",
        "}",
      ),
    }));
    expect(links).toContain("Registry.Fire@5 _onSigned -> League/Main.cs::Main.Handle");
    expect(links).toContain("Registry.Run@6 cb -> League/Main.cs::Main.Other");
    expect(links.filter((l) => l.includes("Decoy"))).toEqual([]);
    // The field is only written by `Subscribe`, never with `Other`.
    expect(links).not.toContain("Registry.Fire@5 _onSigned -> League/Main.cs::Main.Other");
  });

  it("states nothing when no file declares the name as a delegate", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Registry.cs": lines(
        "namespace League;",
        "public class Registry {",
        "  private ClubAction _onSigned;",
        "  public void Subscribe(ClubAction cb) { _onSigned = cb; }",
        "  public void Fire(string c) { _onSigned(c); }",
        "}",
      ),
      "League/Main.cs": lines(
        "namespace League;",
        "public class Main {",
        "  public void Wire(Registry r) { r.Subscribe(Handle); }",
        "  public void Handle(string club) {}",
        "}",
      ),
    }));
    expect(links).toEqual([]);
  });

  it("refuses a name that is also a class", async () => {
    const links = flowLinks(await analyzeAll({
      ...delegateFile,
      "League/ClubAction.cs": lines("namespace League;", "public class ClubAction { }"),
      "League/Registry.cs": lines(
        "namespace League;",
        "public class Registry {",
        "  private ClubAction _onSigned;",
        "  public void Subscribe(ClubAction cb) { _onSigned = cb; }",
        "  public void Fire(string c) { _onSigned(c); }",
        "}",
      ),
      "League/Main.cs": lines(
        "namespace League;",
        "public class Main {",
        "  public void Wire(Registry r) { r.Subscribe(Handle); }",
        "  public void Handle(string club) {}",
        "}",
      ),
    }));
    expect(links).toEqual([]);
  });

  it("follows an event typed by a delegate another file declares", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Delegates.cs": lines("namespace League;", "public delegate void SignedHandler(object who);"),
      "League/Club.cs": lines(
        "namespace League;",
        "public class Club {",
        "  public event SignedHandler Signed;",
        "  public void Sign() { Signed?.Invoke(this); }",
        "}",
      ),
      "League/Fan.cs": lines(
        "namespace League;",
        "public class Fan {",
        "  public void Cheer(object who) {}",
        "  public void Decoy(object who) {}",
        "  public void Watch(Club c) { c.Signed += Cheer; }",
        "}",
      ),
    }));
    expect(links).toContain("Club.Sign@4 Signed?.Invoke -> League/Fan.cs::Fan.Cheer");
    expect(links.filter((l) => l.includes("Decoy"))).toEqual([]);
  });
});

describe("C# value flow: top-level statements", () => {
  it("hands a top-level local function to a method that runs it", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Registry.cs": lines(
        "using System;",
        "namespace League;",
        "public class Registry {",
        "  public void Run(Action<string> cb, string c) { cb(c); }",
        "}",
      ),
      "Program.cs": lines(
        "var r = new League.Registry();",
        "void Kickoff(string club) { }",
        "r.Run(Kickoff, \"x\");",
      ),
      "League/Other.cs": lines("namespace League;", "public class Other { public void Kickoff(string club) {} public void Decoy(string c) {} }"),
    }));
    expect(links).toContain("Registry.Run@4 cb -> Program.cs::Kickoff");
    expect(links.filter((l) => l.includes("Other."))).toEqual([]);
  });

  it("does not take a bare name that is no top-level function for a method group", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Registry.cs": lines(
        "using System;",
        "namespace League;",
        "public class Registry {",
        "  public void Run(Action<string> cb, string c) { cb(c); }",
        "}",
      ),
      "Program.cs": lines(
        "var r = new League.Registry();",
        "r.Run(Kickoff, \"x\");",
      ),
      "League/Other.cs": lines("namespace League;", "public class Other { public static void Kickoff(string club) {} }"),
    }));
    expect(links).toEqual([]);
  });
});

describe("C# value flow: a member sharing its type's name with a method", () => {
  it("still flows when the parameter is both called and stored", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Delegates.cs": lines("namespace League;", "public delegate void Match(string club);"),
      "League/Fixture.cs": lines(
        "namespace League;",
        "public class Fixture {",
        "  public Match Match { get; set; }",
        "  public void Match2(string c) { Match(c); }",
        "  void Register(Match cb) { cb(\"x\"); Match = cb; }",
        "}",
      ),
      "League/Main.cs": lines(
        "namespace League;",
        "public class Main {",
        "  public void Wire(Fixture f) { f.Register(Handle); }",
        "  public void Handle(string c) {}",
        "}",
      ),
    }));
    expect(links).toContain("Fixture.Match2@4 Match -> League/Main.cs::Main.Handle");
  });
});

describe("C# value flow: a plain-typed parameter only handed on", () => {
  const board = lines(
    "namespace League;",
    "public class Board {",
    "  private Kick _kick;",
    "  public void Set(Kick k) { _kick = k; }",
    "  public void Run(Player p) { _kick(p); }",
    "}",
  );
  const setup = lines(
    "namespace League;",
    "public class Setup {",
    "  private readonly Board _board = new();",
    "  public void Register(Kick handler) => _board.Set(handler);",
    "  public void Go() { Register(Penalty); }",
    "  void Penalty(Player p) {}",
    "  void Decoy(Player p) {}",
    "}",
  );

  it("follows the handler through a parameter that is never called there", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Kick.cs": lines("namespace League;", "public delegate void Kick(Player p);", "public class Player {}"),
      "League/Board.cs": board,
      "League/Setup.cs": setup,
    }));
    expect(links).toEqual(["Board.Run@5 _kick -> League/Setup.cs::Setup.Penalty"]);
  });

  it("states nothing when the type is a class", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Kick.cs": lines("namespace League;", "public class Kick {}", "public class Player {}"),
      "League/Board.cs": board,
      "League/Setup.cs": setup,
    }));
    expect(links).toEqual([]);
  });
});

describe("C# value flow: a delegate in a referenced sub-project", () => {
  const web = {
    "League.Web/Board.cs": lines(
      "namespace League.Web;",
      "public class Board {",
      "  private Kick _kick;",
      "  public void Set(Kick k) { _kick = k; }",
      "  public void Run(Player p) { _kick(p); }",
      "}",
    ),
    "League.Web/Setup.cs": lines(
      "namespace League.Web;",
      "public class Setup {",
      "  public void Go() { new Board().Set(Penalty); }",
      "  void Penalty(Player p) {}",
      "}",
    ),
  };
  const subProjects = (references: string[]): SubProject[] => [
    { id: "core", name: "League.Core", root: "League.Core", kind: "dotnet", markers: [] },
    { id: "other", name: "Other", root: "Other", kind: "dotnet", markers: [] },
    { id: "web", name: "League.Web", root: "League.Web", kind: "dotnet", markers: [], references: references.map((project) => ({ project, file: "League.Web/League.Web.csproj" })) },
  ];
  const projectOf = (rel: string): string => (rel.startsWith("League.Core") ? "core" : rel.startsWith("Other") ? "other" : "web");

  it("finds the delegate through the project reference, with no using", async () => {
    const analyses = await analyzeAll({
      ...web,
      "League.Core/Kick.cs": lines("namespace League;", "public delegate void Kick(Player p);", "public class Player {}"),
      // A namesake class in a project nothing references.
      "Other/Kick.cs": lines("namespace League;", "public class Kick {}"),
    }, projectOf);
    expect(flowLinks(analyses, subProjects(["core"]))).toEqual(["Board.Run@5 _kick -> League.Web/Setup.cs::Setup.Penalty"]);
    expect(flowLinks(analyses, subProjects([]))).toEqual([]);
  });

  it("does not take a namesake class of an unreferenced project for the delegate", async () => {
    const analyses = await analyzeAll({
      ...web,
      "Other/Kick.cs": lines("namespace League;", "public delegate void Kick(Player p);", "public class Player {}"),
    }, projectOf);
    expect(flowLinks(analyses, subProjects(["core"]))).toEqual([]);
  });
});

describe("C# value flow: same-named locals in sibling scopes", () => {
  it("keeps each block's local apart at top level and in a method", async () => {
    const links = flowLinks(await analyzeAll({
      "League/Program.cs": lines(
        "{",
        "  Action h = Corner;",
        "  h();",
        "}",
        "{",
        "  Action h = Foul;",
        "  h();",
        "}",
        "void Corner() {}",
        "void Foul() {}",
      ),
      "League/Ref.cs": lines(
        "namespace League;",
        "class Ref {",
        "  void Main() {",
        "    { Action act = A; act(); }",
        "    { Action act = B; act(); }",
        "  }",
        "  void A() {}",
        "  void B() {}",
        "}",
      ),
    }));
    expect(links).toEqual([
      "<setup>@3 h -> League/Program.cs::Corner",
      "<setup>@7 h -> League/Program.cs::Foul",
      "Ref.Main@4 act -> League/Ref.cs::Ref.A",
      "Ref.Main@5 act -> League/Ref.cs::Ref.B",
    ]);
  });
});
