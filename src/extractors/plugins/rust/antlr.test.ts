import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { readRust } from "./antlr.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import "../../registry.js";

const GARAGE = `use crate::db;

/// A garage.
///
/// Holds cars.
pub struct Garage { pool: Pool }

impl Garage {
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }

    pub async fn park(&self, car: Car) -> Result<(), Error> {
        let Some(slot) = self.repo.find_slot(car.size) else { return Err(Error::Full) };
        if car.electric && let Some(charger) = slot.charger() {
            charger.plug(&car);
        }
        let report = Club::new(7).squad().captain();
        db::insert(&self.pool, &car).await?.confirm();
        tracing::info!("parked {}", car.plate.normalize());
        fn helper(c: &Car) -> u8 { c.wheels() }
        let wash = async |c: &Car| wash_car(c).await;
        Self::audit(&car);
        Ok(())
    }
}
`;

describe("Rust through ANTLR", () => {
  it("reads every fn with its exact span, a nested one owning its calls", () => {
    const parsed = readRust(GARAGE);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.line, f.endLine])).toEqual([
      ["new", 9, 11],
      ["park", 13, 25],
      ["helper", 21, 21],
    ]);
    expect(parsed.functions.find((f) => f.name === "helper")!.calls.map((c) => c.name)).toEqual(["c.wheels"]);
  });

  it("names calls as the regex patterns do, macro arguments included", () => {
    const park = readRust(GARAGE).functions.find((f) => f.name === "park")!;
    expect(park.calls.map((c) => c.name)).toEqual([
      "repo.find_slot",
      "slot.charger",
      "charger.plug",
      "Club.new().squad",
      "Club.new().squad().captain",
      "Club.new",
      "insert",
      "confirm",
      "plate.normalize",
      "wash_car",
      "Self.audit",
    ]);
    expect(park.calls.find((c) => c.name === "Club.new")).toMatchObject({ receiverType: "Club" });
  });

  it("names calls the patterns miss or misname (real-repo FP)", () => {
    const calls = (src: string) => readRust(src).functions.flatMap((f) => f.calls.map((c) => c.name));
    // A macro's arguments are code: chains in them are named.
    expect(calls("fn f() { assert_eq!(Squad::new(11).captain().number(), 9); }")).toContain("Squad.new().captain().number");
    // An attribute on an expression names nothing; a field reached through a tuple field still has a name.
    expect(calls("fn f() { #[allow(deprecated)] self.load(id).save(); pool.0.semaphore.release(1); }")).toEqual(["self.load().save", "self.load", "semaphore.release"]);
    // A tuple struct built by its name: its methods are the type's.
    expect(readRust("fn f() { Lineup(players).announce(); }").functions[0]!.calls.find((c) => c.name === "Lineup.announce")).toMatchObject({ receiverType: "Lineup" });
    // A builder chain is named to its end, not three calls deep.
    expect(calls("fn f() { Fixture::new().home(a).away(b).referee(c).venue(d).kickoff(); }")).toContain("Fixture.new().home().away().referee().venue().kickoff");
  });

  it("reads the functions macros declare (real-repo FP)", () => {
    const names = (src: string) => readRust(src).functions.map((f) => f.name);
    // A bare signature, a `cfg_if!`-style braced group, a `macro_rules!` template with a spliced repetition.
    expect(names("define_function!(fn total(x: u8) -> u8);\n")).toEqual(["total"]);
    expect(names("cfg_select! { if #[cfg(unix)] { fn kickoff() {} } else { fn whistle() {} } }\n")).toEqual(["kickoff", "whistle"]);
    expect(names("macro_rules! squad { ($($body:tt)*) => { mod generated { $($body)* fn captain() -> u8 { 9 } } }; ($name:ident) => { fn $name() {} }; }\n")).toEqual(["captain"]);
  });

  it("parses what the upstream grammar refuses in real code (real-repo FP)", () => {
    const ok = (src: string) => expect(readRust(src).syntaxErrors, src).toBe(0);
    // Doc comments holding `*`, and an empty `///` line before an attribute.
    ok("/*! A garage.\n * Holds **cars**. */\n///\n#[derive(Debug)]\nstruct Car;\n");
    // Strings ending in a backslash, C strings, tabs, `~` in a macro.
    ok('fn f() { let a = "\\\\"; let b = c"x"; m!(a ~ b);\tg(); }\n');
    // `let … else`, let chains, async closures, `_ =`, inline const, raw borrows, `..=` patterns.
    ok("fn f() { let Ok(x) = y else { return }; while let Some(z) = it.next() && z > 0 {} let c = async move || 1; _ = g(); let k = const { 3 }; let p = &raw mut x; match n { ..=5 => {} _ => {} } }\n");
    // Block-like statements going on with `.`, `?` and an assignment; match arms without commas.
    ok("fn f() -> R { unsafe { b.as_mut() }.header.start = 1; match a { A => {} B => {}.len(), _ => 0 } if c { d } else { e }.map_err(g)? }\n");
    // Casts, associated type bounds and defaults, generic methods' bounds, `use<>` capturing, unsafe attributes.
    ok("trait T { type Error: Display; type Item<'a> = &'a u8 where Self: 'a; }\nstruct D<const N: usize = 3>;\nfn f(x: impl Iterator<Item: Copy> + use<'a>) { let p = s as *const &'static Loc<'static> as usize; let q = e as Box<dyn Error + Send>; let r = &mut t as &mut (dyn FnMut() + '_); }\n#[unsafe(no_mangle)]\nfn g() {}\n");
    // Weak keywords as names, `&&T`, keywords as macro metavariables.
    ok("fn f(union: u8) { self.union(a); let h = |r: &&Range| r.len(); }\nmacro_rules! m { ($type:ty) => {}; }\n");
  });

  it("counts the syntax errors of a file the grammar cannot read, so core keeps the regex reading", () => {
    expect(readRust("fn f( {\n").syntaxErrors).toBeGreaterThan(0);
  });
});

/**
 * Where the two readings of a fixture differ, and why the parser's is the one to keep: `file → function →
 * [calls only the patterns record, calls only the parser records]`. A method on a call's result is named as the
 * chain from its first call (`args.iter().position`, `Router.new().route()`), which the linker types through
 * declared return types. The patterns name none of these on one line — a bare name after `)` would let any
 * same-named function capture it — and on a chain rustfmt wraps they read each step as a bare method, one per
 * line (`.bind(id)`, `.fetch_all(pool)`). A method on a struct literal is the type's (`ClubShow { id }.with_query()`);
 * a method on a tuple field (`a.1.cmp(…)`) has no name to give.
 */
const KNOWN: Record<string, Record<string, [string[], string[]]>> = {
  "test-fixtures/sample-dead-code/native/src/old_parser.rs": {
    parse_v1: [[], ["s.trim().to_string"]],
  },
  "test-fixtures/sample-dead-code/native/src/parser.rs": {
    parse: [[], ["input.trim().to_string"]],
  },
  "test-fixtures/sample-rust-axum/src/admin.rs": {
    serve: [["service", "wrap", "bind"], ["HttpServer.new().bind", "App.new().service", "App.new().service().service"]],
  },
  "test-fixtures/sample-rust-axum/src/main.rs": {
    main: [["route", "route_layer", "layer", "with_state"], ["Router.new().route", "Router.new().route().route", "Router.new().route().route().route", "Router.new().route().route().route().route_layer", "Router.new().route().route().route().route_layer().layer", "Router.new().route().route().route().route_layer().layer().with_state", "unwrap"]],
    auth: [[], ["req.headers().get", "req.headers().get().is_none"]],
  },
  "test-fixtures/sample-rust-axum/src/repo.rs": {
    pool: [[], ["expect"]],
    list_cars: [["fetch_all"], []],
    get_car: [["bind", "fetch_optional"], []],
    create_car: [["bind", "execute"], []],
    delete_car: [["bind", "execute"], []],
  },
  "test-fixtures/sample-rust-traits/app/src/main.rs": {
    main: [["with_query"], ["ClubShow.with_query"]],
  },
  "test-fixtures/sample-rust-cli/src/config.rs": {
    "Config.from_args": [["unwrap_or_else", "position", "and_then"], ["args.get().map().unwrap_or_else", "args.iter().position", "args.iter().position().and_then", "args.iter().any"]],
  },
  "test-fixtures/sample-rust-cli/src/main.rs": {
    main: [[], ["reporter.write_json().expect"]],
  },
  "test-fixtures/sample-rust-cli/src/output.rs": {
    "Reporter.write_json": [["ok_or", "map_err"], ["output_file.as_ref().ok_or"]],
    "Reporter.group_by_extension": [["cmp"], ["counts.entry().or_insert"]],
  },
  "test-fixtures/sample-rust-cli/src/processor.rs": {
    "FileProcessor.run": [[], ["files.iter().map().sum"]],
    "FileProcessor.scan_directory": [["map_err"], ["entry.file_name().to_string_lossy", "entry.file_name().to_string_lossy().to_string", "entry.metadata().map_err"]],
    "FileProcessor.analyze_file": [[], ["content.lines().count"]],
  },
};

describe("Rust: ANTLR and the patterns agree on the fixtures", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/**/*.rs", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} as the patterns do, but where it is listed as better`, () => {
      const src = readFileSync(resolve(root, rel), "utf-8");
      const parsed = readRust(src);
      expect(parsed.syntaxErrors).toBe(0);
      const shape = (a: ReturnType<typeof extractWithRegex>) => [
        ...a.functions.map((f) => ({ name: f.name, line: f.line, endLine: f.endLine, calls: f.calls.map((c) => c.name) })),
        ...a.classes.flatMap((c) => c.methods.map((m) => ({ name: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine, calls: m.calls.map((x) => x.name) }))),
      ];
      const regex = shape(extractWithRegex(src, rel, "rust"));
      const antlr = shape(extractWithRegex(src, rel, "rust", undefined, parsed));
      expect(antlr.map(({ calls: _, ...span }) => span)).toEqual(regex.map(({ calls: _, ...span }) => span));
      const differences: Record<string, [string[], string[]]> = {};
      regex.forEach((fn, i) => {
        const b = antlr[i]!.calls;
        const onlyA = fn.calls.filter((c) => !b.includes(c));
        const onlyB = b.filter((c) => !fn.calls.includes(c));
        if (onlyA.length + onlyB.length > 0) differences[fn.name] = [onlyA, onlyB];
      });
      expect(differences).toEqual(KNOWN[rel] ?? {});
    });
  }
});
