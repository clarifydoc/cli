import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractTopLevelCalls } from "../../shared/call-graph.js";
import { restoreTypedReceiverCalls } from "../../../core/typed-receivers.js";
import { createEmptyAnalysis, type ClassInfo, type FileAnalysis } from "../../../types/analysis.js";
import { PascalExtractor } from "./functions-classes.js";
import { pascalDiBindings } from "./di.js";

async function analyze(code: string): Promise<{ functions: FileAnalysis["functions"]; classes: ClassInfo[]; setup: string[] }> {
  const tree = await parseSource(code, "pascal" as never, "Unit1.pas");
  const extractor = new PascalExtractor();
  const functions = extractor.extractFunctions(tree, code);
  const classes = extractor.extractClasses(tree, code);
  return { functions, classes, setup: extractTopLevelCalls(tree, "pascal").map((c) => c.name) };
}

async function bindingsOf(code: string) {
  const tree = await parseSource(code, "pascal" as never, "Registration.pas");
  return pascalDiBindings(tree, code, "Registration.pas").map(({ line: _line, ...b }) => b);
}

const cls = (classes: ClassInfo[], name: string) => classes.find((c) => c.name === name)!;
const method = (c: ClassInfo, name: string) => c.methods.find((m) => m.name === name)!;
const callNames = (c: ClassInfo, name: string) => method(c, name).calls.map((x) => x.name);

const SERVICE = `unit Shop.Service;
interface
uses Spring.Container, Shop.Intf;
type
  ICarRepo = interface
    ['{11111111-1111-1111-1111-111111111111}']
    function Find(Id: Integer): string;
    procedure Save(const S: string);
  end;

  IAudited = interface(ICarRepo)
    procedure Audit;
  end;

  TSqlCarRepo = class(TInterfacedObject, ICarRepo, IAudited)
  public
    function Find(Id: Integer): string;
    procedure Save(const S: string);
    procedure Audit;
  end;

  TBareRepo = class(ICarRepo)
    function Find(Id: Integer): string;
    procedure Save(const S: string);
  end;

  TCarService = class(TBaseService)
  private
    [Inject]
    FRepo: ICarRepo;
    [Inject('email'), Weak]
    FNotifier: INotifier;
    FA, FB: IClock;
  public
    constructor Create(const ARepo: ICarRepo);
    procedure Run;
    procedure LocalProc;
  end;

implementation

function TSqlCarRepo.Find(Id: Integer): string; begin Result := ''; end;
procedure TSqlCarRepo.Save(const S: string); begin end;
procedure TSqlCarRepo.Audit; begin end;
function TBareRepo.Find(Id: Integer): string; begin Result := ''; end;
procedure TBareRepo.Save(const S: string); begin end;

constructor TCarService.Create(const ARepo: ICarRepo);
begin
  inherited Create;
  FRepo := ARepo;
  FRepo.Find(0);
end;

procedure TCarService.Run;
var
  Calc: TDiscountCalc;
  I: Integer;
  S: string;
  Items: array of TItem;
begin
  Calc := TDiscountCalc.Create;
  Calc.Apply(1.0);
  FRepo.find(1);
end;

procedure TCarService.LocalProc;
  procedure Inner;
  begin
    FNotifier.Send('x');
  end;
begin
  Inner;
end;

initialization
  Bootstrap;
end.`;

describe("pascal classes and interfaces", () => {
  it("marks interfaces, with their method signatures and parent interface", async () => {
    const { classes } = await analyze(SERVICE);
    const repo = cls(classes, "ICarRepo");
    expect(repo.kind).toBe("interface");
    expect(repo.methods.map((m) => m.name)).toEqual(["Find", "Save"]);
    expect(repo.methods.every((m) => m.calls.length === 0)).toBe(true);
    expect(cls(classes, "IAudited")).toMatchObject({ kind: "interface", extends: "ICarRepo" });
  });

  it("splits class parents: base class first, then every implemented interface", async () => {
    const { classes } = await analyze(SERVICE);
    expect(cls(classes, "TSqlCarRepo")).toMatchObject({ extends: "TInterfacedObject", implements: ["ICarRepo", "IAudited"] });
    // `class(ICarRepo)`: an interface this unit declares is never the base class.
    expect(cls(classes, "TBareRepo")).toMatchObject({ extends: null, implements: ["ICarRepo"] });
    expect(cls(classes, "TCarService")).toMatchObject({ extends: "TBaseService", implements: [] });
  });

  it("attributes a constructor's body to it", async () => {
    const { classes } = await analyze(SERVICE);
    const ctor = method(cls(classes, "TCarService"), "constructor");
    expect(ctor.params).toEqual([{ name: "ARepo", type: "ICarRepo", defaultValue: null }]);
    expect(ctor.calls.map((c) => c.name)).toContain("FRepo.Find");
    // The span is the implementation's, not the one-line declaration's.
    expect(ctor.line).toBe(SERVICE.split("\n").indexOf("constructor TCarService.Create(const ARepo: ICarRepo);") + 1);
  });

  it("reads one property per field name, with RTTI attributes and Spring4D's [Inject('name')]", async () => {
    const { classes } = await analyze(SERVICE);
    expect(cls(classes, "TCarService").properties).toEqual([
      { name: "FRepo", type: "ICarRepo", visibility: "private", isStatic: false, isReadonly: false, decorators: ["Inject"] },
      {
        name: "FNotifier", type: "INotifier", visibility: "private", isStatic: false, isReadonly: false,
        decorators: ["Inject('email')", "Weak"], qualifier: "email",
      },
      { name: "FA", type: "IClock", visibility: "private", isStatic: false, isReadonly: false },
      { name: "FB", type: "IClock", visibility: "private", isStatic: false, isReadonly: false },
    ]);
  });

  it("reads declared locals, skipping builtin and structured types", async () => {
    const { classes } = await analyze(SERVICE);
    expect(method(cls(classes, "TCarService"), "Run").localTypes).toEqual([{ name: "Calc", type: "TDiscountCalc" }]);
  });

  it("holds a noise-named call on a typed field until the receiver is known", async () => {
    const { classes } = await analyze(SERVICE);
    const a = createEmptyAnalysis("Unit1.pas", "pascal");
    a.classes = classes;
    expect(callNames(cls(classes, "TCarService"), "Run")).not.toContain("FRepo.find");
    restoreTypedReceiverCalls(a);
    expect(callNames(cls(classes, "TCarService"), "Run")).toContain("FRepo.find");
  });

  it("gives a local procedure's calls to the routine that owns it", async () => {
    const { classes } = await analyze(SERVICE);
    expect(callNames(cls(classes, "TCarService"), "LocalProc")).toEqual(["Inner", "FNotifier.Send"]);
  });

  it("keeps routine calls out of the unit-level <setup>, and attributes out of every call list", async () => {
    const { setup } = await analyze(SERVICE);
    expect(setup).toEqual(["Bootstrap"]);
  });
});

describe("pascal nested types, helpers and generics", () => {
  const UNIT = `unit U;
interface
type
  TOuter = class
  type
    TInner = class
      procedure Go;
    end;
  public
    procedure Run;
  end;
  TStrHelper = class helper for TStrings
    procedure Dump;
  end;
  TBox<T> = class
    procedure Put(const V: T);
  end;
implementation
procedure TOuter.TInner.Go; begin Helper1; end;
procedure TOuter.Run; begin Helper2; end;
procedure TStrHelper.Dump; begin Helper3; end;
procedure TBox<T>.Put(const V: T); begin Helper4; end;
procedure TIncluded.Elsewhere; begin Helper5; end;
end.`;

  it("adopts every method body — nested classes, helpers, generic classes — and keeps an orphan as a routine", async () => {
    const { classes, functions, setup } = await analyze(UNIT);
    expect(callNames(cls(classes, "TInner"), "Go")).toEqual(["Helper1"]);
    expect(callNames(cls(classes, "TOuter"), "Run")).toEqual(["Helper2"]);
    expect(callNames(cls(classes, "TStrHelper"), "Dump")).toEqual(["Helper3"]);
    expect(cls(classes, "TStrHelper").extends).toBeNull();
    expect(callNames(cls(classes, "TBox"), "Put")).toEqual(["Helper4"]);
    // `TIncluded` is declared in an include file: its method is kept as a routine.
    expect(functions.find((f) => f.name === "TIncluded.Elsewhere")!.calls.map((c) => c.name)).toEqual(["Helper5"]);
    expect(setup).toEqual([]);
  });
});

describe("pascal container lookups", () => {
  const UNIT = `unit U;
interface
implementation
procedure TSvc.ResolveCase;
var
  R: ICarRepo;
  N: INotifier;
begin
  R := GlobalContainer.Resolve<ICarRepo>;
  N := GlobalContainer.Resolve<INotifier>('sms');
  GlobalContainer.Resolve<INotifier>('email').Send('x');
  ServiceLocator.GetService<IClock>.NowUtc;
  GlobalContainer.Resolve<IClock>().NowUtc;
  GlobalContainer.Resolve<IRepo>(Name).Find(1);
  Other.Make<IRepo>.Find(1);
  var C := TDiscountCalc.Create;
  var Q := GlobalContainer.Resolve<IQueue>('jobs');
  var X := MakeBall;
end;
end.`;

  it("types locals from declarations, named lookups and inline variables", async () => {
    const { functions } = await analyze(UNIT);
    const fn = functions.find((f) => f.name === "TSvc.ResolveCase")!;
    expect(fn.localTypes).toEqual([
      { name: "R", type: "ICarRepo" },
      { name: "N", type: "INotifier", qualifier: "sms" },
      { name: "C", type: "TDiscountCalc" },
      { name: "Q", type: "IQueue", qualifier: "jobs" },
    ]);
  });

  it("types the receiver of a lookup chained into a call — and only of a lookup", async () => {
    const { functions } = await analyze(UNIT);
    const fn = functions.find((f) => f.name === "TSvc.ResolveCase")!;
    const typed = fn.calls.filter((c) => c.receiverType).map((c) => [c.name.split(".").pop(), c.receiverType, c.receiverQualifier]);
    expect(typed).toEqual([
      ["Send", "INotifier", "email"],
      ["NowUtc", "IClock", undefined],
      ["NowUtc", "IClock", undefined],
    ]);
  });

  it("drops a local given two different types", async () => {
    const { functions } = await analyze(`unit U;
interface
implementation
procedure Go;
begin
  var C := TFoo.Create;
  var C := TBar.Create;
end;
end.`);
    expect(functions.find((f) => f.name === "Go")!.localTypes).toBeUndefined();
  });
});

describe("pascal Spring4D registrations", () => {
  it("reads every registration form the text decides", async () => {
    expect(await bindingsOf(`unit Registration;
interface
implementation
procedure RegisterServices;
begin
  GlobalContainer.RegisterType<TSqlCarRepo>.Implements<ICarRepo>;
  GlobalContainer.RegisterType<IClock, TSystemClock>;
  GlobalContainer.RegisterType<TEmailNotifier>.Implements<INotifier>('email');
  GlobalContainer.RegisterType<TSmsNotifier>.Implements<INotifier>('sms').AsDefault;
  GlobalContainer.RegisterType<TLedger>.Implements<ILedger>.Implements<IArchive>('ledger').AsDefault<ILedger>.AsSingleton;
  GlobalContainer.RegisterType<IArchive, TDbArchive>('db');
  GlobalContainer.RegisterType<INotifier>.DelegateTo(
    function: INotifier
    begin
      Result := TPushNotifier.Create(GlobalContainer.Resolve<IClock>);
    end);
  GlobalContainer.RegisterInstance<IClock>(TFixedClock.Create(0));
  GlobalContainer.RegisterType(TypeInfo(TFileAudit)).Implements(TypeInfo(IAudit));
  with GlobalContainer do
    RegisterType<TMemCache>.Implements<ICache>;
end;
end.`)).toEqual([
      { service: "ICarRepo", implementation: "TSqlCarRepo", via: "RegisterType" },
      { service: "IClock", implementation: "TSystemClock", via: "RegisterType" },
      { service: "INotifier", implementation: "TEmailNotifier", via: "RegisterType", qualifier: "email", keyedOnly: true },
      { service: "INotifier", implementation: "TSmsNotifier", via: "RegisterType", qualifier: "sms", primary: true },
      { service: "ILedger", implementation: "TLedger", via: "RegisterType", primary: true },
      { service: "IArchive", implementation: "TLedger", via: "RegisterType", qualifier: "ledger", keyedOnly: true },
      { service: "IArchive", implementation: "TDbArchive", via: "RegisterType", qualifier: "db", keyedOnly: true },
      { service: "INotifier", implementation: "TPushNotifier", via: "RegisterType" },
      { service: "IClock", implementation: "TFixedClock", via: "RegisterInstance" },
      { service: "IAudit", implementation: "TFileAudit", via: "RegisterType" },
      { service: "ICache", implementation: "TMemCache", via: "RegisterType" },
    ]);
  });

  it("skips what is decided at run time, and keeps disagreeing registrations", async () => {
    expect(await bindingsOf(`unit Registration;
interface
implementation
procedure RegisterServices;
begin
  GlobalContainer.RegisterType<TCarService>.AsSingleton;
  GlobalContainer.RegisterType<TPricing>;
  GlobalContainer.RegisterType<TPricing>.DelegateTo(function: TPricing begin Result := TPricing.Create; end);
  GlobalContainer.RegisterType<INotifier>.DelegateTo(
    function: INotifier
    begin
      if Debug then Result := TFake.Create else Result := TReal.Create;
    end);
  GlobalContainer.RegisterInstance<IClock>(MakeClock);
  if Debug then
    GlobalContainer.RegisterType<TFakeMailer>.Implements<IMailer>
  else
    GlobalContainer.RegisterType<TSmtpMailer>.Implements<IMailer>;
end;
end.`)).toEqual([
      { service: "IMailer", implementation: "TFakeMailer", via: "RegisterType" },
      { service: "IMailer", implementation: "TSmtpMailer", via: "RegisterType" },
    ]);
  });

  it("does nothing for a unit without registrations", async () => {
    expect(await bindingsOf(`unit U; interface implementation procedure X; begin Y.Register(Z); end; end.`)).toEqual([]);
  });
});
