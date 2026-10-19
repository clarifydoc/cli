import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { goSpec } from "./index.js";
import { extractGoLocalTypes } from "./locals.js";
import { parseGoFields } from "./classes.js";

const lines = (src: string) => src.split("\n");
const classesOf = (src: string) => {
  const l = lines(src);
  return goSpec.extractClasses!(l, extractFunctionsWithSpec(l, goSpec));
};
const byName = <T extends { name: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.name, x]));

describe("Go methods belong to their receiver type", () => {
  const src = `
package svc

type PgRepo struct {
	db *sql.DB
}

func (r *PgRepo) Load(id int) (*User, error) { return nil, nil }
func (r PgRepo) Name() string { return "pg" }

func (c *Cache) Load(id int) error { return nil }

func NewPgRepo() *PgRepo { return &PgRepo{} }
`;

  it("attaches pointer and value receivers to the struct, and others to a stub", () => {
    const classes = byName(classesOf(src));
    expect(classes["PgRepo"]!.methods.map((m) => m.name)).toEqual(["Load", "Name"]);
    expect(classes["PgRepo"]!.properties.map((p) => p.name)).toEqual(["db"]);
    // `Cache` is declared in another file of the package: a stub with this file's method.
    expect(classes["Cache"]).toMatchObject({ properties: [], line: 11, endLine: 11 });
    expect(classes["Cache"]!.methods.map((m) => m.name)).toEqual(["Load"]);
  });

  it("keeps two types' same-named methods apart and out of the top-level functions", () => {
    const a = extractWithRegex(src, "svc/pg.go", "go");
    expect(a.functions.map((f) => f.name)).toEqual(["NewPgRepo"]);
    const symbols = a.classes.flatMap((c) => c.methods.map((m) => `${c.name}.${m.name}`));
    expect(symbols).toEqual(["PgRepo.Load", "PgRepo.Name", "Cache.Load"]);
  });

  it("types the receiver variable as a local of its method", () => {
    const classes = byName(classesOf(`
type Svc struct{ repo Repo }

func (s *Svc) Run(id int) {
	s.validate(id)
	s.repo.Find(id)
}

func (Svc) Anonymous() {}
`));
    const run = classes["Svc"]!.methods[0]!;
    expect(run.localTypes).toEqual([{ name: "s", type: "Svc" }]);
    expect(run.calls.map((c) => c.name)).toEqual(["s.validate", "repo.Find"]);
    expect(classes["Svc"]!.methods[1]!.localTypes).toBeUndefined();
  });

  it("does not type a receiver that a local of the same name shadows", () => {
    const classes = byName(classesOf(`
func (s *Svc) Run() {
	if s := other(); s != nil {
		s.Do()
	}
}
`));
    expect(classes["Svc"]!.methods[0]!.localTypes).toBeUndefined();
  });

  it("reads generic receivers and generic functions", () => {
    const a = extractWithRegex(`
type Stack[T any] struct {
	items []T
}

func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }

func Map[T, U any](xs []T, f func(T) U) []U {
	return nil
}
`, "s.go", "go");
    expect(a.classes.map((c) => [c.name, c.methods.map((m) => m.name)])).toEqual([["Stack", ["Push"]]]);
    expect(a.functions.map((f) => f.name)).toEqual(["Map"]);
    expect(a.functions[0]!.params.map((p) => p.name)).toEqual(["xs", "f"]);
  });
});

describe("Go interfaces", () => {
  it("are structural interfaces with their method specs as methods", () => {
    const classes = byName(classesOf(`
type UserRepo interface {
	// Load one user.
	Load(id int) (*User, error)
	Save(
		ctx context.Context,
		u *User,
	) error
}

type Closer interface{ Close() error }
`));
    const repo = classes["UserRepo"]!;
    expect(repo).toMatchObject({ kind: "interface", structural: true });
    expect(repo.methods.map((m) => [m.name, m.line, m.endLine, m.returnType])).toEqual([
      ["Load", 4, 4, "User"],
      ["Save", 5, 8, "error"],
    ]);
    expect(repo.methods[1]!.params.map((p) => `${p.name}:${p.type}`)).toEqual(["ctx:context.Context", "u:User"]);
    expect(repo.methods.every((m) => m.calls.length === 0)).toBe(true);
    expect(classes["Closer"]).toMatchObject({ kind: "interface", structural: true });
    expect(classes["Closer"]!.methods.map((m) => m.name)).toEqual(["Close"]);
  });

  it("is not matched structurally when part of its method set is embedded", () => {
    const classes = byName(classesOf(`
type ReadSaver interface {
	io.Reader
	Save(u *User) error
}

type Number interface {
	~int | ~float64
}
`));
    expect(classes["ReadSaver"]!.kind).toBe("interface");
    expect(classes["ReadSaver"]!.structural).toBeUndefined();
    expect(classes["ReadSaver"]!.methods.map((m) => m.name)).toEqual(["Save"]);
    expect(classes["Number"]!.structural).toBeUndefined();
  });

  it("reads declarations inside a `type ( … )` group", () => {
    const classes = classesOf(`
type (
	Finder interface {
		Find(id int) error
	}
	PgFinder struct {
		db string
	}
	Handler func(int)
)
`);
    expect(classes.map((c) => [c.name, c.kind ?? "class"])).toEqual([["Finder", "interface"], ["PgFinder", "class"]]);
    expect(classes[1]!.properties.map((p) => p.name)).toEqual(["db"]);
  });
});

describe("Go struct fields", () => {
  it("covers embedded fields, grouped names, trailing comments and one-line bodies", () => {
    const classes = byName(classesOf(`
type UserService struct {
	UserRepo
	*Base
	log.Logger
	repo  UserRepo // injected
	conc  *PgRepo \`inject:""\`
	a, b  *PgRepo
	url   string \`doc:"http://x"\` // the // in the tag stays
}

type Pair struct{ a int; b *PgRepo }
`));
    const props = classes["UserService"]!.properties;
    expect(props.map((p) => `${p.name}:${p.type}`)).toEqual([
      "UserRepo:UserRepo", "Base:*Base", "Logger:log.Logger",
      "repo:UserRepo", "conc:*PgRepo", "a:*PgRepo", "b:*PgRepo", "url:string",
    ]);
    expect(props[0]!.decorators).toEqual(["embedded"]);
    expect(props[3]!.decorators).toBeUndefined();
    expect(props[4]!.decorators).toEqual(['inject:""']);
    expect(props[7]!.decorators).toEqual(['doc:"http://x"']);
    expect(classes["Pair"]!.properties.map((p) => `${p.name}:${p.type}`)).toEqual(["a:int", "b:*PgRepo"]);
  });

  it("skips func-typed and inline-struct fields and blank names", () => {
    expect(parseGoFields("OnChange func(Product)")).toEqual([]);
    expect(parseGoFields("Inner struct { X int }")).toEqual([]);
    expect(parseGoFields("_ struct{}")).toEqual([]);
    expect(parseGoFields("Raw interface{}")[0]!.type).toBe("interface{}");
  });
});

describe("Go parameters", () => {
  it("gives every name of a group the type written after it", () => {
    const fns = extractFunctionsWithSpec(lines(`func Copy(dst, src *Buffer, n int) {}`), goSpec);
    goSpec.extractClasses!(lines(`func Copy(dst, src *Buffer, n int) {}`), fns);
    expect(fns[0]!.params.map((p) => `${p.name}:${p.type}`)).toEqual(["dst:Buffer", "src:Buffer", "n:int"]);
  });

  it("leaves anonymous parameter lists anonymous", () => {
    const src = lines(`func handler(int, string) error { return nil }`);
    const fns = extractFunctionsWithSpec(src, goSpec);
    goSpec.extractClasses!(src, fns);
    expect(fns[0]!.params.map((p) => `${p.name}:${p.type}`)).toEqual(["_:int", "_:string"]);
  });
});

describe("Go typed locals", () => {
  const locals = (body: string, ctors?: Map<string, string[]>) => extractGoLocalTypes(lines(body), [], ctors);

  it("reads composite literals, new(), and declared var types", () => {
    expect(locals(`
	a := &PgRepo{dsn: d}
	b := PgRepo{}
	c := new(MemRepo)
	var d UserRepo = &PgRepo{}
	var e *PgRepo
	var f = repo.Store{}
`)).toEqual([
      { name: "a", type: "*PgRepo" },
      { name: "b", type: "PgRepo" },
      { name: "c", type: "*MemRepo" },
      { name: "d", type: "UserRepo" },
      { name: "e", type: "*PgRepo" },
      { name: "f", type: "repo.Store" },
    ]);
  });

  it("types a local from a same-file constructor's result at its position", () => {
    const ctors = new Map([["NewRepo", ["*PgRepo", "error"]], ["NewSvc", ["*Svc"]]]);
    expect(locals(`
	r, err := NewRepo(cfg)
	s := NewSvc()
	t := NewSvc().With(x)
	u := other.NewSvc()
`, ctors)).toEqual([
      { name: "r", type: "*PgRepo" },
      { name: "err", type: "error" },
      { name: "s", type: "*Svc" },
      // Another package's function: core types it by its declared result.
      { name: "u", type: "", from: "other.NewSvc()" },
    ]);
  });

  it("hands a call it cannot type to core as the local's initializer — the first result only", () => {
    expect(locals(`	a := NewConcRepo()`)).toEqual([{ name: "a", type: "", from: "NewConcRepo()" }]);
    expect(locals(`	u, err := repo.Find(id)
	n := len(xs)
	c := svc.Open().Conn()`)).toEqual([{ name: "u", type: "", from: "repo.Find()" }]);
  });

  it("drops a name declared again with another or an unknown type", () => {
    expect(locals(`
	m := &MemRepo{}
	if m := pick(); m != nil {
		m.Find(1)
	}
	x := &PgRepo{}
	for _, x := range xs {
	}
	k := []PgRepo{}
	y := map[string]int{}
`)).toEqual([]);
  });

  it("does not let a local of another type override a parameter of the same name", () => {
    expect(extractGoLocalTypes(lines(`	repo := &MemRepo{}`), [{ name: "repo", type: "UserRepo", defaultValue: null }])).toEqual([]);
    expect(extractGoLocalTypes(lines(`	repo := &MemRepo{}`), [{ name: "repo", type: "MemRepo", defaultValue: null }]))
      .toEqual([{ name: "repo", type: "*MemRepo" }]);
  });

  it("reaches locals of a one-line body through the spec", () => {
    const a = extractWithRegex(`
func NewPg() *PgRepo { return &PgRepo{} }
func Use() { r := NewPg(); r.Find(1) }
`, "u.go", "go");
    expect(a.functions[1]!.localTypes).toEqual([{ name: "r", type: "*PgRepo" }]);
  });
});

describe("Go embedded fields downstream", () => {
  it("never become entity columns", () => {
    const a = extractWithRegex(`
package models

type User struct {
	gorm.Model
	Name  string \`gorm:"size:255"\`
	Email string
}
`, "models/user.go", "go");
    const user = a.classes.find((c) => c.name === "User")!;
    expect(user.decorators).toContain("entity");
    expect(user.properties.map((p) => p.name)).toEqual(["Name", "Email"]);
  });

  it("are left out of a request schema unless a json name makes them a field", async () => {
    const { goRequestSchema } = await import("./request-schema.js");
    const [base] = parseGoFields("Base");
    const [named] = parseGoFields('Base `json:"base"`');
    expect(goRequestSchema.isSerialized(base!)).toBe(false);
    expect(goRequestSchema.isSerialized(named!)).toBe(true);
    expect(goRequestSchema.serializedName(named!)).toBe("base");
  });
});

describe("struct tags containing semicolons", () => {
  it("keeps a GORM tag whole instead of cutting the member at its first `;`", async () => {
    const { extractGoClasses } = await import("./classes.js");
    const lines = [
      "type Photo struct {",
      "\tCamera *Camera `gorm:\"association_autoupdate:false;association_autocreate:false\" json:\"Camera\"`",
      "\tAlbums []Album `json:\"Albums\"`",
      "}",
    ];
    const [photo] = extractGoClasses(lines, [], (t: string) => ({ name: t.trim(), type: null, defaultValue: null }));
    expect(photo!.properties.map((p) => [p.name, p.type])).toEqual([["Camera", "*Camera"], ["Albums", "[]Album"]]);
  });
});
