import { describe, it, expect } from "vitest";
import { extractCallsFromBody, extractFunctionsWithSpec } from "../shared/regex-base.js";
import { vbSpec } from "./index.js";
import { producedClass, vbCodeText } from "./di.js";

const lines = (src: string) => src.split("\n");
const classes = (src: string) => vbSpec.extractClasses!(lines(src), []);
const bindings = (src: string) => vbSpec.extractDiBindings!(lines(src), "Startup.vb");
const locals = (body: string) => vbSpec.extractLocalTypes!(lines(body), { name: "f", params: [] });
const calls = (body: string) => extractCallsFromBody(lines(body), 0, lines(body).length, vbSpec.lineCommentPrefixes, vbSpec.callPatterns);

describe("VB interfaces and implementations", () => {
  const CONTRACTS = `
Namespace Shop
    Public Interface IGreeter
        Function Greet(name As String) As String
    End Interface

    Public Interface IRepo
        Function Find(id As Integer) As String
        Sub Save(item As String)
        Function [Get](id As Integer) As String
    End Interface

    Public Interface IAdminRepo
        Inherits IRepo, IDisposable
        Sub Purge()
    End Interface
End Namespace`;

  it("marks VB interfaces as interfaces with their member signatures", () => {
    const [greeter, repo, admin] = classes(CONTRACTS);
    expect(greeter).toMatchObject({ name: "IGreeter", kind: "interface" });
    expect(repo!.methods.map((m) => m.name)).toEqual(["Find", "Save", "Get"]);
    expect(admin).toMatchObject({ name: "IAdminRepo", kind: "interface", extends: "IRepo", implements: ["IDisposable"] });
  });

  it("gives interface members no body — no calls borrowed from the next member's lines", () => {
    for (const cls of classes(CONTRACTS)) {
      for (const m of cls.methods) {
        expect(m.calls).toEqual([]);
        expect(m.endLine).toBe(m.line);
      }
    }
  });

  it("reads Implements on its own line, inline after `:`, several at once, qualified and generic", () => {
    const src = `
Public Class FormalGreeter
    Implements IGreeter
    Public Function Greet(name As String) As String Implements IGreeter.Greet
        Return "Good day " & name
    End Function
End Class

Public Class SystemClock : Implements IClock
End Class

Public Class Multi : Inherits BaseThing : Implements IA, Global.App.IB
End Class

Partial Public Class Wrapped
#Region "Contracts"
    Inherits BaseThing
    Implements IRepo(Of User), _
               IAudit
#End Region
    Private _x As Integer
End Class

Public Class Next1
End Class
Public Class Next2
    Implements INotNext1
End Class`;
    const byName = new Map(classes(src).map((c) => [c.name, c]));
    expect(byName.get("FormalGreeter")!.implements).toEqual(["IGreeter"]);
    expect(byName.get("SystemClock")!.implements).toEqual(["IClock"]);
    expect(byName.get("Multi")).toMatchObject({ extends: "BaseThing", implements: ["IA", "Global.App.IB"] });
    expect(byName.get("Wrapped")).toMatchObject({ extends: "BaseThing", implements: ["IRepo(Of User)", "IAudit"] });
    // The header scan stops at the class's first member — a later class's
    // `Implements` never leaks into an earlier one.
    expect(byName.get("Next1")!.implements).toEqual([]);
    expect(byName.get("Next2")!.implements).toEqual(["INotNext1"]);
  });

  it("finds MustInherit classes and gives MustOverride members no body", () => {
    const src = `
Public MustInherit Class Shape
    Public MustOverride Function Area() As Double
    Public Function Describe() As String
        Return Format(Area())
    End Function
End Class

Public MustInherit Class Notifier
    Public MustOverride Sub Send(msg As String)
    Public MustOverride Function Ping() As Boolean
End Class

Public NotInheritable Class Square
    Inherits Shape
    Public Overrides Function Area() As Double
        Return 4
    End Function
End Class`;
    const byName = new Map(classes(src).map((c) => [c.name, c]));
    const shape = byName.get("Shape")!;
    expect(shape.kind).toBeUndefined(); // a concrete member keeps it a class
    expect(shape.methods.find((m) => m.name === "Area")!.calls).toEqual([]);
    expect(shape.methods.find((m) => m.name === "Describe")!.calls.map((c) => c.name)).toContain("Area");
    // Nothing but abstract members: an interface in all but name.
    expect(byName.get("Notifier")!.kind).toBe("interface");
    expect(byName.get("Square")).toMatchObject({ extends: "Shape" });
  });

  it("keys a constructor parameter and the field it is stored in with <FromKeyedServices>", () => {
    const src = `
Public Class Checkout
    Private ReadOnly _sms As INotifier
    Private ReadOnly _any As INotifier
    Public Sub New(<FromKeyedServices("sms")> sms As INotifier, any As INotifier)
        _sms = sms
        Me._any = any
    End Sub
End Class`;
    const [cls] = classes(src);
    const ctor = cls!.methods.find((m) => m.name === "New")!;
    expect(ctor.params).toEqual([
      { name: "sms", type: "INotifier", defaultValue: null, qualifier: "sms" },
      { name: "any", type: "INotifier", defaultValue: null },
    ]);
    expect(cls!.properties.find((p) => p.name === "_sms")!.qualifier).toBe("sms");
    expect(cls!.properties.find((p) => p.name === "_any")!.qualifier).toBeUndefined();
  });
});

describe("VB typed locals", () => {
  it("reads declared, constructed, container-resolved and cast locals", () => {
    expect(locals(`
        Dim calc As New DiscountCalc()
        Dim calc2 = New DiscountCalc(1)
        Dim box As New Box(Of User)()
        Dim g As IGreeter = sp.GetRequiredService(Of IGreeter)()
        Dim k = sp.GetRequiredService(Of IClock)()
        Dim n = sp.GetRequiredKeyedService(Of INotifier)("sms")
        Dim m As INotifier = sp.GetRequiredKeyedService(Of INotifier)("email")
        Dim c = CType(sp.GetService(GetType(IClock)), IClock)
        Dim d = DirectCast(o, IRepo)
        Dim r As IRepo
        Using scope As New UnitOfWork()
        End Using
        For Each item As OrderLine In order.Lines
        Next`)).toEqual([
      { name: "calc", type: "DiscountCalc" },
      { name: "calc2", type: "DiscountCalc" },
      { name: "box", type: "Box(Of User)" },
      { name: "g", type: "IGreeter" },
      { name: "k", type: "IClock" },
      { name: "n", type: "INotifier", qualifier: "sms" },
      { name: "m", type: "INotifier", qualifier: "email" },
      { name: "c", type: "IClock" },
      { name: "d", type: "IRepo" },
      { name: "r", type: "IRepo" },
      { name: "scope", type: "UnitOfWork" },
      { name: "item", type: "OrderLine" },
    ]);
  });

  it("shares a type across `Dim a, b As T`, splits `:` statements and joins `_` continuations", () => {
    expect(locals(`
        Dim a, b As Repo, c As Clock
        Dim x = New Foo() : Dim y As Bar
        Dim z = _
            sp.GetRequiredService(Of IZed)()`)).toEqual([
      { name: "a", type: "Repo" },
      { name: "b", type: "Repo" },
      { name: "c", type: "Clock" },
      { name: "x", type: "Foo" },
      { name: "y", type: "Bar" },
      { name: "z", type: "IZed" },
    ]);
  });

  it("states nothing it cannot read: untyped, builtin, array, ambiguous and computed locals", () => {
    expect(locals(`
        Dim untyped = MakeRepo()
        Dim count As Integer = 0
        Dim name As String
        Dim items() As Repo
        Dim twice As RepoA
        Dim twice As RepoB
        Dim chained = New Foo().Configure()
        Dim f = Function(x) x + 1
        ' Dim commented As Hidden
        Dim s = "Dim fake As Nope"`)).toEqual([]);
  });

  it("is case-insensitive about keywords", () => {
    expect(locals(`dim r as new Repo()
DIM k = sp.getrequiredservice(of IClock)()`)).toEqual([
      { name: "r", type: "Repo" },
      { name: "k", type: "IClock" },
    ]);
  });
});

describe("VB container lookups chained into a call", () => {
  it("types the receiver of a lookup or a cast", () => {
    const found = calls(`
        sp.GetRequiredService(Of IClock)().NowUtc()
        provider.GetService(Of IRepo).Find(1)
        CType(sp.GetService(GetType(IPricer)), IPricer).Price(2D)
        DirectCast(o, IRepo).Save(x)
        sp.GetRequiredKeyedService(Of INotifier)(Keys.Sms).Send("m")`);
    const typed = found.filter((c) => c.receiverType).map((c) => [c.name.split(".").pop(), c.receiverType, c.receiverQualifier]);
    expect(typed).toEqual([
      ["NowUtc", "IClock", undefined],
      ["Find", "IRepo", undefined],
      ["Price", "IPricer", undefined],
      ["Save", "IRepo", undefined],
      ["Send", "INotifier", "Keys.Sms"],
    ]);
  });

  it("never types a keyed lookup whose literal key it cannot read", () => {
    const found = calls(`sp.GetRequiredKeyedService(Of INotifier)("sms").Send("m")`);
    expect(found.filter((c) => c.receiverType)).toEqual([]);
  });

  it("keeps the noise-named leaf of a typed lookup (`find`, `send`)", () => {
    const found = calls(`sp.GetRequiredService(Of IRepo)().find(1)`);
    expect(found.find((c) => c.receiverType === "IRepo")?.name).toBe("sp.GetRequiredService(Of IRepo)().find");
  });
});

describe("VB container registrations", () => {
  it("reads Microsoft.Extensions.DependencyInjection registrations, every form", () => {
    expect(bindings(`
Public Module Registration
    Public Sub Register(services As IServiceCollection)
        services.AddScoped(Of IGreeter, FormalGreeter)()
        services.AddSingleton(Of IClock, SystemClock)()
        services.AddTransient(Of OrderService)()
        services.AddScoped(GetType(IGreeter), GetType(CasualGreeter))
        services.AddScoped(GetType(IRepo(Of )), GetType(SqlRepo(Of )))
        services.TryAddScoped(Of IPricer, DefaultPricer)()
        services.AddKeyedSingleton(Of INotifier, EmailNotifier)("email")
        services.AddKeyedScoped(Of INotifier)("sms", Function(sp, key) New SmsNotifier())
        services.AddScoped(Of IAudit)(Function(sp) New DbAudit(sp.GetRequiredService(Of IClock)()))
        services.AddSingleton(Of ICache)(New MemoryCacheAdapter())
        services.AddScoped(Of IAlias)(Function(sp) sp.GetRequiredService(Of IGreeter)())
        services.AddHttpClient(Of IWeather, WeatherClient)()
        services.addscoped(of ILower, LowerImpl)()
    End Sub
End Module`)).toEqual([
      { service: "IGreeter", implementation: "FormalGreeter", via: "AddScoped", line: 4 },
      { service: "IClock", implementation: "SystemClock", via: "AddSingleton", line: 5 },
      { service: "IGreeter", implementation: "CasualGreeter", via: "AddScoped", line: 7 },
      { service: "IRepo", implementation: "SqlRepo", via: "AddScoped", line: 8 },
      { service: "IPricer", implementation: "DefaultPricer", via: "TryAddScoped", ifAbsent: true, line: 9 },
      { service: "INotifier", implementation: "EmailNotifier", via: "AddKeyedSingleton", qualifier: "email", keyedOnly: true, line: 10 },
      { service: "INotifier", implementation: "SmsNotifier", via: "AddKeyedScoped", qualifier: "sms", keyedOnly: true, line: 11 },
      { service: "IAudit", implementation: "DbAudit", via: "AddScoped", line: 12 },
      { service: "ICache", implementation: "MemoryCacheAdapter", via: "AddSingleton", line: 13 },
      { service: "IAlias", implementation: "IGreeter", via: "AddScoped", line: 14 },
      { service: "IWeather", implementation: "WeatherClient", via: "AddHttpClient", line: 15 },
      { service: "ILower", implementation: "LowerImpl", via: "addscoped", line: 16 },
    ]);
  });

  it("reads registrations spread over continuation lines and multi-line factories", () => {
    expect(bindings(`
        services _
            .AddScoped(Of IRepo, SqlRepo)()
        services.AddScoped(Of IAudit)(Function(sp)
                                          Return New DbAudit()
                                      End Function)
        services.AddScoped(Of IBad)(Function(sp)
                                        Dim x = 1
                                        Return New Bad(x)
                                    End Function)
        With services
            .AddSingleton(Of IClock, SystemClock)()
        End With`)).toEqual([
      { service: "IRepo", implementation: "SqlRepo", via: "AddScoped", line: 3 },
      { service: "IAudit", implementation: "DbAudit", via: "AddScoped", line: 4 },
      { service: "IClock", implementation: "SystemClock", via: "AddSingleton", line: 12 },
    ]);
  });

  it("skips what the source does not decide: self registrations, computed factories, comments, strings", () => {
    expect(bindings(`
        services.AddScoped(Of OrderService)()
        services.AddScoped(Of IRepo)(Function(sp) MakeRepo(sp))
        services.AddScoped(Of IRepo)(Function(sp) New SqlRepo().WithCache())
        ' services.AddScoped(Of IRepo, CommentedRepo)()
        Log("services.AddScoped(Of IRepo, StringRepo)()")
        services.AddScoped(GetType(OrderService))`)).toEqual([]);
  });

  it("keeps conflicting registrations — the linker refuses to choose between them", () => {
    const found = bindings(`
        If env.IsDevelopment() Then
            services.AddScoped(Of IMailer, FakeMailer)()
        Else
            services.AddScoped(Of IMailer, SmtpMailer)()
        End If`);
    expect(found.map((b) => b.implementation)).toEqual(["FakeMailer", "SmtpMailer"]);
  });

  it("reads Autofac, Unity and Simple Injector registrations", () => {
    expect(bindings(`
        builder.RegisterType(Of SqlRepo)().As(Of IRepo)().InstancePerLifetimeScope()
        builder.RegisterType(Of SmtpMailer)() _
            .As(Of IMailer)() _
            .PreserveExistingDefaults()
        builder.RegisterType(Of EmailNotifier)().Named(Of INotifier)("email")
        builder.RegisterType(Of SmsNotifier)().Keyed(Of INotifier)(Channel.Sms)
        builder.Register(Function(c) New DbAudit(c.Resolve(Of IClock)())).As(Of IAudit)()
        builder.RegisterInstance(New SystemClock()).As(Of IClock)()
        builder.RegisterType(Of Scanned)().AsImplementedInterfaces()
        builder.RegisterType(Of Plain)()
        container.RegisterType(Of IPricer, FancyPricer)()
        container.RegisterType(Of IPricer, CheapPricer)("cheap")
        container.RegisterInstance(Of ICache)(New MemCache())
        container.Register(Of IWeather, WeatherClient)(Lifestyle.Scoped)
        container.RegisterSingleton(Of IFeed, RssFeed)()
        container.Register(Of IQueue)(Function() New MemQueue(), Lifestyle.Singleton)`).map(({ line: _l, ...b }) => b)).toEqual([
      { service: "IRepo", implementation: "SqlRepo", via: "RegisterType" },
      { service: "IMailer", implementation: "SmtpMailer", via: "RegisterType", ifAbsent: true },
      { service: "INotifier", implementation: "EmailNotifier", via: "RegisterType", qualifier: "email", keyedOnly: true },
      { service: "INotifier", implementation: "SmsNotifier", via: "RegisterType", qualifier: "Channel.Sms", keyedOnly: true },
      { service: "IAudit", implementation: "DbAudit", via: "Register" },
      { service: "IClock", implementation: "SystemClock", via: "RegisterInstance" },
      { service: "IPricer", implementation: "FancyPricer", via: "RegisterType" },
      { service: "IPricer", implementation: "CheapPricer", via: "RegisterType", qualifier: "cheap", keyedOnly: true },
      { service: "ICache", implementation: "MemCache", via: "RegisterInstance" },
      { service: "IWeather", implementation: "WeatherClient", via: "Register" },
      { service: "IFeed", implementation: "RssFeed", via: "RegisterSingleton" },
      { service: "IQueue", implementation: "MemQueue", via: "Register" },
    ]);
  });

  it("does not read a method declaration named Register as a registration", () => {
    expect(bindings(`Public Sub Register(services As IServiceCollection)`)).toEqual([]);
  });
});

describe("VB DI helpers", () => {
  it("blanks strings (with doubled quotes) and comments but keeps columns", () => {
    const line = `x = "a ""q"" (b)" ' note (c)`;
    const code = vbCodeText(line);
    expect(code).toHaveLength(line.length);
    expect(code).not.toMatch(/[abcq]\)/);
    expect(code.startsWith(`x = "`)).toBe(true);
  });

  it("reads the class a factory produces only when it is one plain construction", () => {
    expect(producedClass("Function(sp) New Repo(sp.GetRequiredService(Of IDb)())")).toBe("Repo");
    expect(producedClass("New Ns.Repo With {.Cache = True}")).toBe("Repo");
    expect(producedClass("New Box(Of User)(1)")).toBe("Box");
    expect(producedClass("Function(sp) \n    New Repo()")).toBe("Repo");
    expect(producedClass("Function(sp)\n    Return New Repo()\nEnd Function")).toBe("Repo");
    expect(producedClass("Function(sp)\n    Log(sp)\n    Return New Repo()\nEnd Function")).toBeNull();
    expect(producedClass("Function(sp) If(flag, New A(), New B())")).toBeNull();
    expect(producedClass("Sub(sp) New A()")).toBeNull();
  });

  it("keeps a top-level VB function's typed locals", () => {
    const [fn] = extractFunctionsWithSpec(lines(`Function Make() As IRepo
    Dim r As New SqlRepo()
    Return r
End Function`), vbSpec);
    expect(fn!.localTypes).toEqual([{ name: "r", type: "SqlRepo" }]);
  });
});
