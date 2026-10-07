import { describe, it, expect } from "vitest";
import { extractGoDiBindings } from "./di-bindings.js";

const bindings = (src: string) =>
  extractGoDiBindings(src.split("\n")).map(({ service, implementation, line, via, qualifier, keyedOnly }) =>
    ({ service, implementation, line, via, ...(qualifier ? { qualifier } : {}), ...(keyedOnly ? { keyedOnly } : {}) }));

describe("Go DI bindings: wire", () => {
  it("reads wire.Bind inside NewSet/Build, across lines, with qualifiers stripped", () => {
    expect(bindings(`
var RepoSet = wire.NewSet(
	NewPgUserRepo,
	wire.Bind(new(UserRepo), new(*PgUserRepo)),
)

func Init() *Svc {
	wire.Build(
		wire.Bind(
			new(repo.Notifier),
			new(*mail.SmtpNotifier),
		),
	)
	return nil
}
`)).toEqual([
      { service: "UserRepo", implementation: "PgUserRepo", line: 4, via: "wire.Bind" },
      { service: "Notifier", implementation: "SmtpNotifier", line: 9, via: "wire.Bind" },
    ]);
  });

  it("reads wire.InterfaceValue with a constructed value, not with another value", () => {
    expect(bindings(`
var Set = wire.NewSet(
	wire.InterfaceValue(new(UserRepo), &MemUserRepo{}),
	wire.InterfaceValue(new(io.Reader), os.Stdin),
)
`)).toEqual([{ service: "UserRepo", implementation: "MemUserRepo", line: 3, via: "wire.InterfaceValue" }]);
  });

  it("emits conflicting registrations and ignores commented-out ones", () => {
    expect(bindings(`
var Prod = wire.NewSet(wire.Bind(new(UserRepo), new(*PgUserRepo)))
// var Old = wire.NewSet(wire.Bind(new(UserRepo), new(*OldRepo)))
var Test = wire.NewSet(wire.Bind(new(UserRepo), new(*MemUserRepo)))
`).map((b) => b.implementation)).toEqual(["PgUserRepo", "MemUserRepo"]);
  });
});

describe("Go DI bindings: fx and dig", () => {
  it("binds fx.As to what a same-file provider builds; a named result is keyed-only", () => {
    expect(bindings(`
func NewPg() *PgUserRepo { return &PgUserRepo{} }

func NewMem(db *sql.DB) UserRepo {
	return &MemUserRepo{db: db}
}

var Module = fx.Options(
	fx.Provide(
		fx.Annotate(NewPg, fx.As(new(UserRepo)), fx.ResultTags(\`name:"pg"\`)),
		fx.Annotate(
			NewMem,
			fx.ParamTags(\`name:"ro"\`),
			fx.As(new(UserRepo), new(io.Closer)),
		),
	),
)
`)).toEqual([
      { service: "UserRepo", implementation: "PgUserRepo", line: 10, via: "fx.As", qualifier: "pg", keyedOnly: true },
      { service: "UserRepo", implementation: "MemUserRepo", line: 11, via: "fx.As" },
      { service: "Closer", implementation: "MemUserRepo", line: 11, via: "fx.As" },
    ]);
  });

  it("reads a func-literal provider", () => {
    expect(bindings(`
var M = fx.Provide(fx.Annotate(func() *MemRepo { return &MemRepo{} }, fx.As(new(UserRepo))))
`)).toEqual([{ service: "UserRepo", implementation: "MemRepo", line: 2, via: "fx.As" }]);
  });

  it("names a provider it cannot see (the linker reads its result), and skips value groups and fx.Self", () => {
    expect(bindings(`
var M = fx.Options(
	fx.Provide(fx.Annotate(pg.NewRepo, fx.As(new(UserRepo)))),
	fx.Provide(fx.Annotate(NewElsewhere, fx.As(new(UserRepo)))),
	fx.Provide(fx.Annotate(NewLocal, fx.As(new(Handler)), fx.ResultTags(\`group:"routes"\`))),
	fx.Provide(fx.Annotate(NewLocal, fx.As(fx.Self()))),
)

func NewLocal() *Local { return &Local{} }
`).map((b) => [b.service, b.implementation])).toEqual([
      ["UserRepo", "NewRepo"],
      ["UserRepo", "NewElsewhere"],
    ]);
  });

  it("uses the declared pointer result when the body builds in several places", () => {
    expect(bindings(`
func newPg(dsn string) (*PgUserRepo, error) {
	if dsn == "" {
		return nil, errEmpty
	}
	return &PgUserRepo{dsn: dsn}, nil
}

func newIface() UserRepo {
	if x { return &A{} }
	return &B{}
}

func Build(c *dig.Container) {
	c.Provide(newPg, dig.As(new(UserRepo)), dig.Name("pg"))
	c.Provide(newIface, dig.As(new(Other)))
}
`)).toEqual([{ service: "UserRepo", implementation: "PgUserRepo", line: 15, via: "dig.As", qualifier: "pg", keyedOnly: true }]);
  });

  it("returns nothing for a file without a DI library", () => {
    expect(extractGoDiBindings(["package svc", "func New() *Svc { return &Svc{} }"])).toEqual([]);
  });
});
