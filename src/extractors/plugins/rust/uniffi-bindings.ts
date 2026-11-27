import type { ForeignBindingRule } from "../../../types/analysis.js";
import { crateName, join, packageName } from "./foreign-bindings.js";
import { escapeRegex } from "../shared/path-utils.js";

type Declared = NonNullable<ForeignBindingRule["declared"]>;

const MAX_SCAFFOLD_FILES = 64;

/** The section's body in a TOML text (`[bindings.kotlin]`), or "". */
function tomlSection(toml: string, header: string): string {
  const escaped = escapeRegex(header);
  return new RegExp(`^[^\\S\\r\\n]*\\[${escaped}\\][^\\S\\r\\n]*$([\\s\\S]*?)(?=^[^\\S\\r\\n]*\\[|(?![\\s\\S]))`, "m").exec(toml)?.[1] ?? "";
}

const tomlString = (body: string, key: string): string | undefined => new RegExp(`^[^\\S\\r\\n]*${key}\\s*=\\s*"([^"]+)"`, "m").exec(body)?.[1];

/** The text between the `{` at `open` and its closing `}`. */
function braceBody(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** The statements of a UDL block (split at `;` outside brackets), each without its leading `[Attributes]`. */
function udlStatements(body: string): Array<{ attrs: string; text: string }> {
  const out: Array<{ attrs: string; text: string }> = [];
  for (const raw of body.split(";")) {
    const m = /^\s*((?:\[[^\]]*\]\s*)*)([\s\S]*?)\s*$/.exec(raw);
    if (m?.[2]) out.push({ attrs: m[1] ?? "", text: m[2] });
  }
  return out;
}

/** What a UDL file declares: its namespace's functions and its interfaces with their methods (Rust spelling). */
export function parseUdl(udl: string): { namespace: string | null; declared: Declared } {
  const text = udl.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const declared: Declared = { functions: [], classes: [] };
  const ns = /\bnamespace\s+(\w+)\s*\{/.exec(text);
  if (ns) {
    for (const st of udlStatements(braceBody(text, ns.index + ns[0].length - 1))) {
      const fn = /(\w+)\s*\(/.exec(st.text)?.[1];
      if (fn) declared.functions.push(fn);
    }
  }
  for (const m of text.matchAll(/(?:\[[^\]]*\]\s*)?\binterface\s+(\w+)\s*\{/g)) {
    const cls = { name: m[1]!, methods: [] as string[], constructors: [] as string[] };
    for (const st of udlStatements(braceBody(text, m.index + m[0].length - 1))) {
      if (/^constructor\b/.test(st.text)) {
        const named = /\bName\s*=\s*(\w+)/.exec(st.attrs)?.[1];
        if (named) cls.methods.push(named);
        else cls.constructors.push("new");
        continue;
      }
      const method = /(\w+)\s*\(/.exec(st.text)?.[1];
      if (method) cls.methods.push(method);
    }
    declared.classes.push(cls);
  }
  return { namespace: ns?.[1] ?? null, declared };
}

/** The text between the `(` at `open` and its closing `)`. */
function parenBody(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** A directory spelled in a manifest of the analyzed corpus: refused when it could leave the package (`..`, absolute, home, drive letter, NUL). */
const safeRelative = (p: string): boolean => !p.includes("\0") && !/^(?:[\\/]|~|[A-Za-z]:)/.test(p) && !p.split(/[\\/]+/).includes("..");

/**
 * The Swift package targets that wrap a generated uniffi module: each `.target` / `.executableTarget` of a
 * `Package.swift` (found above an analyzed Swift file) whose dependencies name `ffiModule` (the generated
 * `<module>FFI` binary target). A target's sources are `path:` or `Sources/<name>`.
 */
function swiftWrappers(ffiModule: string, read: (path: string) => string | undefined, files: ReadonlySet<string>, root: string): Array<{ name: string; dir: string }> {
  const out: Array<{ name: string; dir: string }> = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.endsWith(".swift")) continue;
    for (let dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""; ; dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "") {
      if (!seen.has(dir) && (root === "" || dir === root || dir.startsWith(`${root}/`))) {
        seen.add(dir);
        const manifest = read(join(dir, "Package.swift"))?.replace(/(?<!:)\/\/[^\n]*/g, "");
        if (manifest?.includes(`"${ffiModule}"`)) {
          for (const m of manifest.matchAll(/\.(?:executableTarget|target)\s*\(/g)) {
            const body = parenBody(manifest, m.index + m[0].length - 1);
            const name = /\bname\s*:\s*"([^"]+)"/.exec(body)?.[1];
            if (!name || !body.includes(`"${ffiModule}"`)) continue;
            const path = /\bpath\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? `Sources/${name}`;
            if (safeRelative(path)) out.push({ name, dir: join(dir, path) });
          }
        }
      }
      if (dir === "") break;
    }
  }
  return out;
}

/**
 * uniffi crates: a Cargo.toml that depends on `uniffi` and sources that set up its scaffolding
 * (`uniffi::setup_scaffolding!()` for proc macros, `uniffi::include_scaffolding!("league")` beside a
 * `src/league.udl`). The crate's namespace is the macro's argument, the UDL's own, or the library name;
 * the generated Kotlin package is `uniffi.<namespace>` and the Swift module the namespace, unless the
 * crate's `uniffi.toml` says `package_name` / `module_name`. Calls join only through an import of that
 * package or module (core, `foreign-bindings.ts`); a proc-macro crate binds what carries `#[uniffi::export]`
 * (or sits in such an `impl`) and the types deriving `uniffi::Object`, a UDL crate what the UDL declares.
 */
export function uniffiBindings(root: string, read: (path: string) => string | undefined, files: ReadonlySet<string>): ForeignBindingRule[] {
  const rules: ForeignBindingRule[] = [];
  for (const f of files) {
    const m = /^(?:(.*)\/)?src\/lib\.rs$/.exec(f);
    if (!m) continue;
    const dir = m[1] ?? "";
    if (root !== "" && dir !== root && !dir.startsWith(`${root}/`)) continue;
    const cargo = read(join(dir, "Cargo.toml"));
    if (!cargo || !/\buniffi\b/.test(cargo)) continue;
    const prefix = `${join(dir, "src")}/`;
    let namespace: string | null = null;
    let declared: Declared | undefined;
    let scanned = 0;
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith(".rs") || ++scanned > MAX_SCAFFOLD_FILES) continue;
      const text = read(file);
      if (!text?.includes("scaffolding!")) continue;
      const include = /\binclude_scaffolding!\s*\(\s*"([^"]+)"/.exec(text)?.[1];
      if (include) {
        const udl = read(join(dir, "src", `${include}.udl`));
        const parsed = udl === undefined ? null : parseUdl(udl);
        namespace = parsed?.namespace ?? include;
        if (parsed) declared = parsed.declared;
        break;
      }
      const setup = /\bsetup_scaffolding!\s*\(\s*(?:"([^"]+)")?\s*\)/.exec(text);
      if (setup) {
        const lib = tomlSection(cargo, "lib");
        namespace = setup[1] ?? crateName(tomlString(lib, "name") ?? packageName(cargo) ?? "");
        break;
      }
    }
    if (!namespace) continue;
    const config = read(join(dir, "uniffi.toml")) ?? "";
    const targets = [
      { ext: ".kt", importerExtensions: [".kt"], name: tomlString(tomlSection(config, "bindings.kotlin"), "package_name") ?? `uniffi.${namespace}`, kind: "kotlin" },
      { ext: ".swift", importerExtensions: [".swift"], name: tomlString(tomlSection(config, "bindings.swift"), "module_name") ?? namespace, kind: "swift" },
    ];
    for (const t of targets) {
      // Swift: the generated `<module>FFI` module and each package target wrapping the generated file (its own
      // sources call the generated names without an import).
      const wrappers = t.kind === "swift" ? swiftWrappers(`${t.name}FFI`, read, files, root) : [];
      rules.push({
        tool: "uniffi",
        source: join(dir, "src"),
        sourceExtension: ".rs",
        indexFiles: ["mod.rs", "lib.rs"],
        output: join(dir, `uniffi-${t.kind}`, t.name),
        outputExtension: t.ext,
        single: true,
        rename: "camel",
        importModule: t.name,
        importerExtensions: t.importerExtensions,
        ...(t.kind === "swift" ? { importAlso: [`${t.name}FFI`, ...wrappers.map((w) => w.name)], moduleDirs: wrappers.map((w) => w.dir) } : {}),
        ...(declared
          ? { declared }
          : { decorator: { name: "uniffi::export", required: true, classes: true, constructorAttribute: "uniffi::constructor", classDerive: "uniffi::Object" } }),
      });
    }
  }
  return rules;
}
