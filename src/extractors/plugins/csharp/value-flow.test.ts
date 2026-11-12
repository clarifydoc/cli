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
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
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
      projectId: "root",
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
function flowLinks(analyses: FileAnalysis[]): string[] {
  return buildSymbolLinks(analyses)
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
