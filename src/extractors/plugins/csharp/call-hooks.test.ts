import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars + call hooks
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractClasses } from "../../functions-classes/index.js";
import type { CallInfo } from "../../../types/analysis.js";
import { extractCsharpTopLevelLocalTypes } from "./local-types.js";

async function callsOf(body: string): Promise<CallInfo[]> {
  const src = `class C { void M(IServiceProvider sp, IContainer c, object x) {\n${body}\n} }`;
  const tree = await parseSource(src, "csharp" as any, "C.cs");
  return extractClasses(tree, src, "csharp")[0]!.methods[0]!.calls;
}

const names = (calls: CallInfo[]): string[] => calls.map((c) => c.name);
const receivers = (calls: CallInfo[]) =>
  calls.filter((c) => c.receiverType).map((c) => [c.name, c.receiverType, c.receiverQualifier]);

describe("C# call hooks", () => {
  it("names a null-conditional member call (`x?.M()`) instead of dropping it", async () => {
    expect(names(await callsOf(`_maybe?.Maybe(); this._x?.Run(); a.b?.C(); _y!.Go();`))).toEqual([
      "_maybe?.Maybe", "this._x?.Run", "a.b?.C", "_y!.Go",
    ]);
  });

  it("names a target-typed `new()` after the declaration it initializes — nowhere else", async () => {
    expect(names(await callsOf(`DiscountCalc calc = new(); Use(new()); var v = new Foo();`))).toEqual([
      "new DiscountCalc", "Use", "new Foo",
    ]);
  });

  it("types the receiver of a container lookup chained into the call", async () => {
    const calls = await callsOf(`sp.GetRequiredService<IPricing>().Quote(o);
sp.GetRequiredKeyedService<IStorage>("blob").Store(b);
c.Resolve<IUserStore>().find(1);
c.ResolveNamed<IUserStore>("mongo").Find(2);
sp.GetService<IAudit>()?.Record("x");
sp.GetRequiredService<Shop.Domain.IClock>()!.Now();`);
    expect(receivers(calls)).toEqual([
      ["sp.GetRequiredService<IPricing>().Quote", "IPricing", undefined],
      ["sp.GetRequiredKeyedService<IStorage>(\"blob\").Store", "IStorage", "blob"],
      // `find` is noise by its leaf name — but not on a typed receiver.
      ["c.Resolve<IUserStore>().find", "IUserStore", undefined],
      ["c.ResolveNamed<IUserStore>(\"mongo\").Find", "IUserStore", "mongo"],
      ["sp.GetService<IAudit>()?.Record", "IAudit", undefined],
      ["sp.GetRequiredService<Shop.Domain.IClock>()!.Now", "Shop.Domain.IClock", undefined],
    ]);
  });

  it("types the receiver of a construction or a cast chained into the call", async () => {
    const calls = await callsOf(`new Exporter().Run();
((IFoo)x).Run2();
(sp.GetService(typeof(IBar)) as IBar)!.Run3();`);
    expect(receivers(calls)).toEqual([
      ["new Exporter().Run", "Exporter", undefined],
      ["((IFoo)x).Run2", "IFoo", undefined],
      ["(sp.GetService(typeof(IBar)) as IBar)!.Run3", "IBar", undefined],
    ]);
  });

  it("gives no receiver type to plain receivers, BCL types or non-lookups", async () => {
    const calls = await callsOf(`repo.Save(1);
new List<int>().Add(1);
((string)x).Trim();
sp.GetServices<IPlugin>().First();
Make<IFoo>().Run();
config.Get<Options>().Validate();`);
    expect(receivers(calls)).toEqual([]);
  });

  it("attributes an argument lambda's calls to the member, not a named lambda's or local function's", async () => {
    const calls = await callsOf(`items.ForEach(i => _repo.Save(i));
services.AddScoped<IMailer>(sp => new SmtpMailer(sp.GetRequiredService<IConfig>()));
Func<int> f = () => Compute();
void Local() { Helper(); }`);
    expect(names(calls)).toEqual([
      "items.ForEach", "_repo.Save", "services.AddScoped<IMailer>", "new SmtpMailer", "sp.GetRequiredService<IConfig>",
    ]);
  });
});

describe("C# top-level statements", () => {
  it("types the locals of top-level statements (Program.cs), not those inside its types or lambdas", async () => {
    const src = `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
var pricing = app.Services.GetRequiredService<IPricing>();
IClock clock = new SystemClock();
app.MapGet("/", (IRepo r) => { var inner = new Inner(); return r.All(); });
class Helper { void M() { var hidden = new Hidden(); } }`;
    const tree = await parseSource(src, "csharp" as any, "Program.cs");
    expect(extractCsharpTopLevelLocalTypes(tree.rootNode)).toEqual([
      { name: "pricing", type: "IPricing" },
      { name: "clock", type: "SystemClock" },
    ]);
  });
});
