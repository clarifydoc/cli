import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { rustSpec } from "./index.js";
import { extractRustLocalTypes } from "./locals.js";

const lines = (src: string) => src.split("\n");
const analyze = (src: string, file = "src/lib.rs") => extractWithRegex(src, file, "rust");
const byName = <T extends { name: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.name, x]));

describe("Rust impl blocks", () => {
  const src = `
pub struct PgRepo {
    dsn: String,
}

impl PgRepo {
    pub fn new() -> Self { PgRepo { dsn: String::new() } }
}

impl PlayerRepo for PgRepo {
    fn load(&self, id: i64) -> Option<Player> {
        fn helper() {}
        None
    }
    fn find(&self, id: i64) -> Option<Player> { None }
}

impl fmt::Display for MemRepo {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { Ok(()) }
}

impl<T: Debug> Loggable for T {
    fn log(&self) {}
}

pub fn free() {}
`;

  it("attaches inherent and trait impl methods to the type, with the trait as implemented", () => {
    const a = analyze(src);
    const classes = byName(a.classes);
    expect(classes["PgRepo"]!.methods.map((m) => m.name)).toEqual(["new", "load", "find"]);
    expect(classes["PgRepo"]!.implements).toEqual(["PlayerRepo"]);
    expect(classes["PgRepo"]!.properties.map((p) => p.name)).toEqual(["dsn"]);
  });

  it("puts methods of a type declared elsewhere on a stub of it", () => {
    const stub = byName(analyze(src).classes)["MemRepo"]!;
    expect(stub).toMatchObject({ implements: ["fmt::Display"], properties: [], line: 18 });
    expect(stub.methods.map((m) => m.name)).toEqual(["fmt"]);
  });

  it("leaves blanket impls, nested fns and free fns as functions (no double count)", () => {
    const a = analyze(src);
    expect(a.functions.map((f) => f.name)).toEqual(["helper", "log", "free"]);
    expect(a.classes.map((c) => c.name)).toEqual(["PgRepo", "MemRepo"]);
  });

  it("reads a multi-line impl head with a where clause", () => {
    const a = analyze(`
impl<R> PlayerService<R>
where
    R: PlayerRepo + Send + Sync,
{
    pub fn run(&self, repo: &R) {
        repo.load(1);
    }
}
`);
    const svc = byName(a.classes)["PlayerService"]!;
    expect(svc.methods.map((m) => m.name)).toEqual(["run"]);
    expect(svc.methods[0]!.params).toEqual([{ name: "repo", type: "PlayerRepo", defaultValue: null }]);
  });
});

describe("Rust traits", () => {
  it("are nominal interfaces whose signatures are their methods, counted once", () => {
    const a = analyze(`
pub trait PlayerRepo: Send + Sync {
    fn load(&self, id: i64) -> Option<Player>;
    fn save(
        &self,
        u: &Player,
    ) -> Result<(), String>;
    fn describe(&self) -> String { self.name() }
}
`);
    const repo = a.classes[0]!;
    expect(repo).toMatchObject({ name: "PlayerRepo", kind: "interface" });
    expect(repo.structural).toBeUndefined();
    expect(repo.methods.map((m) => [m.name, m.line])).toEqual([["load", 3], ["save", 4], ["describe", 8]]);
    expect(repo.methods[0]!.calls).toEqual([]);
    expect(a.functions).toEqual([]);
  });
});

describe("Rust generic parameters bounded by one trait", () => {
  it("resolve struct field types through `<R: Trait>` and `where` bounds", () => {
    const classes = byName(analyze(`
pub struct A<R: PlayerRepo> {
    repo: R,
}
pub struct B<R> where R: PlayerRepo {
    repo: Arc<R>,
}
pub struct C<R: PlayerRepo + Clone + 'static, T> {
    repo: R,
    other: T,
}
pub struct D<R: PlayerRepo + Auditor> {
    repo: R,
}
`).classes);
    expect(classes["A"]!.properties[0]!.type).toBe("PlayerRepo");
    expect(classes["B"]!.properties[0]!.type).toBe("Arc<PlayerRepo>");
    expect(classes["C"]!.properties.map((p) => p.type)).toEqual(["PlayerRepo", "T"]);
    // Two real traits: the receiver could reach either — left as written.
    expect(classes["D"]!.properties[0]!.type).toBe("R");
  });

  it("resolve parameter types through fn generics, impl generics and Self", () => {
    const a = analyze(`
pub fn h_gen<R: PlayerRepo>(repo: &R, id: i64) {}
pub fn h_where<R>(repo: Box<R>) where R: crate::repo::PlayerRepo {}
pub fn h_plain(m: HashMap<String, Box<dyn Repo>>) {}

impl<R: PlayerRepo> Svc<R> {
    fn merge(&self, other: &Self, r: R) {}
}
`);
    const fns = byName(a.functions);
    expect(fns["h_gen"]!.params[0]!.type).toBe("PlayerRepo");
    expect(fns["h_where"]!.params[0]!.type).toBe("Box<crate::repo::PlayerRepo>");
    expect(fns["h_plain"]!.params[0]!.type).toBe("HashMap<String, Box<dyn Repo>>");
    const w = byName(a.classes)["Svc"]!.methods[0]!;
    expect(w.params.map((p) => p.type)).toEqual(["Svc", "PlayerRepo"]);
  });
});

describe("Rust struct fields", () => {
  it("are read from a one-line struct body", () => {
    const classes = byName(analyze(`
pub struct PlayerService { repo: PgRepo, pub count: usize }
pub struct Marker;
pub struct Wrapper(Arc<dyn PlayerRepo>);
`).classes);
    expect(classes["PlayerService"]!.properties.map((p) => `${p.name}:${p.type}`)).toEqual(["repo:PgRepo", "count:usize"]);
    expect(classes["Marker"]!.properties).toEqual([]);
  });
});

describe("Rust typed locals", () => {
  const locals = (body: string, params: { name: string; type: string | null; defaultValue: null }[] = []) =>
    extractRustLocalTypes(lines(body), params);

  it("reads declared types, constructors, struct literals and deref wrappers", () => {
    expect(locals(`
    let a = ConcRepo::new();
    let mut b: ConcRepo = ConcRepo::new();
    let c: Arc<dyn PlayerRepo> = Arc::new(PgRepo::new());
    let d = ConcRepo { dsn: String::new() };
    let e = Arc::new(PgRepo::new());
    let f = crate::pg::PgRepo::default();
    let g = PgRepo::new(&url)?;
    let h = Client::new(cfg).expect("client");
    let i = PgRepo {
        dsn,
    };
    let j = Self::new();
`)).toEqual([
      { name: "a", type: "ConcRepo" },
      { name: "b", type: "ConcRepo" },
      { name: "c", type: "Arc<dyn PlayerRepo>" },
      { name: "d", type: "ConcRepo" },
      { name: "e", type: "PgRepo" },
      { name: "f", type: "crate::pg::PgRepo" },
      { name: "g", type: "PgRepo" },
      { name: "h", type: "Client" },
      { name: "i", type: "PgRepo" },
      { name: "j", type: "Self" },
    ]);
  });

  it("does not type what is not plainly a construction, but keeps a call initializer for the linker", () => {
    expect(locals(`
    let a = make_repo();
    let b = PgRepo::builder().build();
    let c = PgRepo::new().with_pool(p);
    let d = PgRepo { dsn }.into_shared();
    let e;
    let m = upgrade_ai_manager(ai_manager)?;
    let v = repo.find(id).await?;
    let ai_manager = upgrade_ai_manager(ai_manager)?;
`, [{ name: "ai_manager", type: "AFPluginState<Weak<AIManager>>", defaultValue: null }])).toEqual([
      // Typed later through what the callee declares it returns (`?` unwraps a Result).
      { name: "a", type: "", from: "make_repo()" },
      // A chain through an intermediate call (\`builder().build()\`) is not followed.
      { name: "m", type: "", from: "upgrade_ai_manager(ai_manager)", awaited: true },
      { name: "v", type: "", from: "repo.find(id)", awaited: true },
      // Shadowing the parameter it upgrades.
      { name: "ai_manager", type: "", from: "upgrade_ai_manager(ai_manager)", awaited: true },
    ]);
  });

  it("drops a name bound again with another or an unknown type", () => {
    expect(locals(`
    let r = PgRepo::new();
    let r = r.into_inner();
    let s = PgRepo::new();
    for s in items {}
    let t = PgRepo::new();
    if let Some(t) = maybe {}
    let u = PgRepo::new();
    let f = |u| u.go();
    let v = MemRepo::new();
`)).toEqual([{ name: "v", type: "MemRepo" }]);
  });

  it("does not let a local of another type override a parameter of the same name", () => {
    expect(locals("    let repo = MemRepo::new();", [{ name: "repo", type: "PlayerRepo", defaultValue: null }])).toEqual([]);
  });

  it("resolves Self in a method's locals to the impl type", () => {
    const a = analyze(`
impl PgRepo {
    pub fn fresh(&self) -> Self {
        let other = Self::new();
        other.reset();
        other
    }
}
`);
    expect(a.classes[0]!.methods[0]!.localTypes).toEqual([{ name: "other", type: "PgRepo" }]);
  });

  it("reaches locals through the spec for plain functions", () => {
    const fns = extractFunctionsWithSpec(lines(`fn f() { let a = ConcRepo::new(); a.load(1); }`), rustSpec);
    expect(fns[0]!.localTypes).toEqual([{ name: "a", type: "ConcRepo" }]);
  });
});
