import { describe, it, expect } from "vitest";
import { extractGoDiBindings } from "./di-bindings.js";

const bindings = (src: string) =>
  extractGoDiBindings(src.split("\n")).map(({ service, implementation, line, via, qualifier, keyedOnly }) =>
    ({ service, implementation, line, via, ...(qualifier ? { qualifier } : {}), ...(keyedOnly ? { keyedOnly } : {}) }));

describe("Go DI bindings: wire", () => {
  it("reads wire.Bind inside NewSet/Build, across lines, with qualifiers stripped", () => {
    expect(bindings(`
var RepoSet = wire.NewSet(
	NewPgPlayerRepo,
	wire.Bind(new(PlayerRepo), new(*PgPlayerRepo)),
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
      { service: "PlayerRepo", implementation: "PgPlayerRepo", line: 4, via: "wire.Bind" },
      { service: "Notifier", implementation: "SmtpNotifier", line: 9, via: "wire.Bind" },
    ]);
  });

  it("reads wire.InterfaceValue with a constructed value, not with another value", () => {
    expect(bindings(`
var Set = wire.NewSet(
	wire.InterfaceValue(new(PlayerRepo), &MemPlayerRepo{}),
	wire.InterfaceValue(new(io.Reader), os.Stdin),
)
`)).toEqual([{ service: "PlayerRepo", implementation: "MemPlayerRepo", line: 3, via: "wire.InterfaceValue" }]);
  });

  it("emits conflicting registrations and ignores commented-out ones", () => {
    expect(bindings(`
var Prod = wire.NewSet(wire.Bind(new(PlayerRepo), new(*PgPlayerRepo)))
// var Old = wire.NewSet(wire.Bind(new(PlayerRepo), new(*OldRepo)))
var Test = wire.NewSet(wire.Bind(new(PlayerRepo), new(*MemPlayerRepo)))
`).map((b) => b.implementation)).toEqual(["PgPlayerRepo", "MemPlayerRepo"]);
  });
});

describe("Go DI bindings: fx and dig", () => {
  it("binds fx.As to what a same-file provider builds; a named result is keyed-only", () => {
    expect(bindings(`
func NewPg() *PgPlayerRepo { return &PgPlayerRepo{} }

func NewMem(db *sql.DB) PlayerRepo {
	return &MemPlayerRepo{db: db}
}

var Module = fx.Options(
	fx.Provide(
		fx.Annotate(NewPg, fx.As(new(PlayerRepo)), fx.ResultTags(\`name:"pg"\`)),
		fx.Annotate(
			NewMem,
			fx.ParamTags(\`name:"ro"\`),
			fx.As(new(PlayerRepo), new(io.Closer)),
		),
	),
)
`)).toEqual([
      { service: "PlayerRepo", implementation: "PgPlayerRepo", line: 10, via: "fx.As", qualifier: "pg", keyedOnly: true },
      { service: "PlayerRepo", implementation: "MemPlayerRepo", line: 11, via: "fx.As" },
      { service: "Closer", implementation: "MemPlayerRepo", line: 11, via: "fx.As" },
    ]);
  });

  it("reads a func-literal provider", () => {
    expect(bindings(`
var M = fx.Provide(fx.Annotate(func() *MemRepo { return &MemRepo{} }, fx.As(new(PlayerRepo))))
`)).toEqual([{ service: "PlayerRepo", implementation: "MemRepo", line: 2, via: "fx.As" }]);
  });

  it("names a provider it cannot see (the linker reads its result), and skips value groups and fx.Self", () => {
    expect(bindings(`
var M = fx.Options(
	fx.Provide(fx.Annotate(pg.NewRepo, fx.As(new(PlayerRepo)))),
	fx.Provide(fx.Annotate(NewElsewhere, fx.As(new(PlayerRepo)))),
	fx.Provide(fx.Annotate(NewLocal, fx.As(new(Handler)), fx.ResultTags(\`group:"routes"\`))),
	fx.Provide(fx.Annotate(NewLocal, fx.As(fx.Self()))),
)

func NewLocal() *Local { return &Local{} }
`).map((b) => [b.service, b.implementation])).toEqual([
      ["PlayerRepo", "NewRepo"],
      ["PlayerRepo", "NewElsewhere"],
    ]);
  });

  it("uses the declared pointer result when the body builds in several places", () => {
    expect(bindings(`
func newPg(dsn string) (*PgPlayerRepo, error) {
	if dsn == "" {
		return nil, errEmpty
	}
	return &PgPlayerRepo{dsn: dsn}, nil
}

func newIface() PlayerRepo {
	if x { return &A{} }
	return &B{}
}

func Build(c *dig.Container) {
	c.Provide(newPg, dig.As(new(PlayerRepo)), dig.Name("pg"))
	c.Provide(newIface, dig.As(new(Other)))
}
`)).toEqual([{ service: "PlayerRepo", implementation: "PgPlayerRepo", line: 15, via: "dig.As", qualifier: "pg", keyedOnly: true }]);
  });

  it("returns nothing for a file without a DI library", () => {
    expect(extractGoDiBindings(["package svc", "func New() *Svc { return &Svc{} }"])).toEqual([]);
  });
});
