import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { stripTypeArguments } from "../shared/path-utils.js";

/**
 * What Objective-C source states about the type of a receiver: a method's parameters (`(Club *)visitor`) and
 * return type, a typed local (`Club *c = …`), and a class's `@property Club *home` with the `_home` instance
 * variable it synthesizes (or one declared in the braces after `@interface`). Facts only — the linker types the
 * message send `[self.home retire]`, named `home.retire`, from the property.
 */

const QUALIFIERS = /\b(?:const|volatile|__kindof|__weak|__strong|__unsafe_unretained|__autoreleasing|__block|_Nullable|_Nonnull|_Null_unspecified|__nullable|__nonnull|nullable|nonnull|null_unspecified|struct|enum|register|static|extern)\b/g;

/**
 * The class a declared type names: `Club *` → `Club`, `__kindof Club *_Nullable` → `Club`, `id<Scoring>` →
 * `Scoring`, `NSArray<Club *> *` → `NSArray`. Null for `id`, `void`, `instancetype`, a block or function pointer.
 */
export function objcType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let t = raw.replace(QUALIFIERS, " ").replace(/\s+/g, " ").trim();
  if (/\(\s*\^|\(\s*\*/.test(t)) return null;
  const proto = /^id\s*<\s*([A-Za-z_]\w*)\s*(?:,[^>]*)?>\s*\*?$/.exec(t);
  if (proto) return proto[1]!;
  t = stripTypeArguments(t).replace(/\*/g, "").trim();
  return /^[A-Z_a-z]\w*$/.test(t) && !/^(?:id|void|instancetype|Class|SEL|BOOL|int|char|float|double|long|short|unsigned|signed)$/.test(t) ? t : null;
}

/** The text of the method declaration starting at `lines[i]`, up to its `{` or `;` (a wrapped selector is joined). */
function declarationText(lines: string[], i: number): string {
  let text = "";
  for (let k = i; k < Math.min(lines.length, i + 8); k++) {
    const code = blankStringLiterals(lines[k]!).replace(/\/\/.*$/, "");
    text += (k === i ? "" : " ") + code.trim();
    if (/[{;]\s*$/.test(code) || code.includes("{")) break;
  }
  return text.replace(/[{;].*$/, "");
}

/** `- (Club *)engine`, `+ (instancetype)shared`: the declared return type, as a class name. */
export function parseObjcReturnType(line: string): string | null {
  const m = /^\s*[-+]\s*\(([^)]*)\)\s*\w/.exec(line);
  return m ? objcType(m[1]) : null;
}

/**
 * The parameters of the method declared at `lines[i]` (`- (void)sign:(Player *)p fee:(NSNumber *)f`): each the
 * name after its `(Type)`, typed by it. Undefined for a line that declares no method (a C function reads as usual).
 */
export function objcParams(lines: string[], i: number): ParamInfo[] | undefined {
  if (!/^\s*[-+]\s*\(/.test(lines[i] ?? "")) return undefined;
  const text = declarationText(lines, i);
  const head = /^\s*[-+]\s*\([^)]*\)\s*/.exec(text);
  if (!head) return undefined;
  const rest = text.slice(head[0].length);
  const params: ParamInfo[] = [];
  for (const m of rest.matchAll(/:\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*([A-Za-z_]\w*)/g)) {
    params.push({ name: m[2]!, type: objcType(m[1]) ?? m[1]!.trim(), defaultValue: null });
  }
  return params;
}

const DECLARED_LOCAL = /^\s*(?:for\s*\(\s*)?((?:(?:const|__block|__weak|__strong|__unsafe_unretained|__kindof|static)\s+)*(?:[A-Z]\w*(?:\s*<[^<>;=]*>)?\s*\*|id\s*<[^<>;=]*>)\s*(?:(?:__weak|__strong|__unsafe_unretained|_Nullable|_Nonnull|const)\s+)*)([a-z_]\w*)\s*(?:=\s*(.*?)|;|\bin\b)/;
const UNTYPED_LOCAL = /^\s*(?:(?:__block|__weak|__strong)\s+)*(?:id|instancetype|__auto_type|auto)\s+([a-z_]\w*)\s*=\s*(.+?)\s*;?\s*$/;

/** `[[Club alloc] init…]`, `[Club new]`: the class a send constructs. */
function constructed(rhs: string): string | null {
  const m = /^\s*\[\s*\[\s*([A-Z]\w*)\s+alloc\s*\]\s+init|^\s*\[\s*([A-Z]\w*)\s+new\s*\]/.exec(rhs);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** Locals whose type the body states: `Club *c = …;`, `Club *c;`, `for (Club *c in clubs)`, `id c = [[Club alloc] init];`. */
export function extractObjcLocalTypes(bodyLines: string[]): NonNullable<FunctionInfo["localTypes"]> {
  const out: NonNullable<FunctionInfo["localTypes"]> = [];
  const seen = new Map<string, string | null>();
  const add = (name: string, type: string): void => {
    const prev = seen.get(name);
    if (prev === undefined) {
      seen.set(name, type);
      out.push({ name, type });
    } else if (prev !== type) {
      // Declared again with another type in another scope: which one a send sees is a scoping question.
      seen.set(name, null);
    }
  };
  for (const raw of bodyLines) {
    const line = blankStringLiterals(raw).replace(/\/\/.*$/, "");
    const m = DECLARED_LOCAL.exec(line);
    if (m) {
      const type = objcType(m[1]);
      if (type) add(m[2]!, type);
      continue;
    }
    const u = UNTYPED_LOCAL.exec(line);
    const made = u ? constructed(u[2]!) : null;
    if (u && made) add(u[1]!, made);
  }
  return out.filter((l) => seen.get(l.name) !== null);
}

/** `@property (nonatomic, strong, readonly) Club *home;` → `home: Club`, and the `_home` instance variable. */
const PROPERTY = /^\s*@property\s*(?:\(([^)]*)\))?\s*([^;]*?)\s*;/;

function propertiesOf(lines: string[], from: number, to: number): PropertyInfo[] {
  const out: PropertyInfo[] = [];
  let depth = 0;
  for (let i = from; i < Math.min(to, lines.length); i++) {
    const line = blankStringLiterals(lines[i]!).replace(/\/\/.*$/, "");
    const prop = PROPERTY.exec(line);
    if (prop) {
      const decl = prop[2]!;
      // The name is the last identifier; a block or function-pointer property is none of ours.
      const name = /([A-Za-z_]\w*)\s*$/.exec(decl)?.[1];
      const type = objcType(decl.slice(0, decl.length - (name?.length ?? 0)));
      if (name && type) {
        const attrs = (prop[1] ?? "").split(",").map((a) => a.trim());
        const base: PropertyInfo = { name, type, visibility: "public", isStatic: attrs.includes("class"), isReadonly: attrs.includes("readonly") };
        out.push(base, { ...base, name: `_${name}`, visibility: "private" });
      }
      continue;
    }
    // Instance variables between the braces of `@interface X () {` / `@implementation X {`.
    for (const ch of line) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    const ivar = /^\s*(?:@(?:private|protected|public|package)\s+)?([A-Z]\w*(?:\s*<[^<>;]*>)?\s*\*|id\s*<[^<>;]*>)\s*([A-Za-z_]\w*)\s*;/.exec(line);
    if (ivar && (depth > 0 || /^\s*[A-Z]/.test(line))) {
      const type = objcType(ivar[1]);
      if (type) out.push({ name: ivar[2]!, type, visibility: "private", isStatic: false, isReadonly: false });
    }
  }
  return out;
}

interface Block {
  kind: "implementation" | "interface" | "protocol";
  name: string;
  superclass: string | null;
  protocols: string[];
  category: boolean;
  line: number;
  endLine: number;
}

const BLOCK_HEAD = /^\s*@(implementation|interface|protocol)\s+([A-Za-z_]\w*)\s*(?:<[^>]*>\s*)?(?::\s*([A-Za-z_]\w*))?\s*(?:<([^>]*)>)?\s*(\(\s*\w*\s*\))?/;

/** Each `@implementation`/`@interface`/`@protocol … @end` block of a file. */
function blocksOf(lines: string[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = BLOCK_HEAD.exec(lines[i]!);
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*@end\b/.test(lines[j]!)) {
        end = j + 1;
        break;
      }
    }
    const kind = m[1] as Block["kind"];
    // `@protocol Scoring;` is a forward declaration, no block.
    if (kind === "protocol" && /@protocol\s+\w+\s*;/.test(lines[i]!)) continue;
    blocks.push({
      kind,
      name: m[2]!,
      superclass: m[3] ?? null,
      protocols: (m[4] ?? "").split(",").map((p) => p.trim()).filter((p) => /^\w+$/.test(p)),
      category: m[5] !== undefined,
      line: i + 1,
      endLine: end,
    });
    i = end - 1;
  }
  return blocks;
}

/**
 * One class per name and file: the `@implementation` holds the methods; the `@interface` of the same file (a class
 * extension in a `.m`, the declaration in a header) adds its superclass, protocols, properties and instance
 * variables, and stands alone when the file has no implementation. A `@protocol` is an interface whose methods
 * are its declarations. A method declared in an `@interface` is no function: its definition is the one in the
 * `@implementation` (`declarationLines`).
 */
export function objcClasses(lines: string[], fns: FunctionInfo[]): ClassInfo[] {
  const byName = new Map<string, ClassInfo>();
  const classes: ClassInfo[] = [];
  const blocks = blocksOf(lines);
  const order = [...blocks.filter((b) => b.kind === "implementation"), ...blocks.filter((b) => b.kind !== "implementation")];
  for (const b of order) {
    if (b.kind === "protocol") {
      classes.push({
        name: b.name, extends: null, implements: b.protocols, decorators: [], kind: "interface",
        methods: protocolMethods(lines, b), properties: propertiesOf(lines, b.line, b.endLine), isExported: true, line: b.line, endLine: b.endLine,
      });
      continue;
    }
    const known = byName.get(b.name);
    if (b.kind === "implementation") {
      const cls: ClassInfo = {
        name: b.name, extends: null, implements: [], decorators: [],
        methods: fns.filter((fn) => fn.line >= b.line && fn.line <= b.endLine),
        properties: propertiesOf(lines, b.line, b.endLine), isExported: true, line: b.line, endLine: b.endLine,
      };
      byName.set(b.name, cls);
      classes.push(cls);
      continue;
    }
    const props = propertiesOf(lines, b.line, b.endLine);
    if (known) {
      known.properties.push(...props.filter((p) => !known.properties.some((q) => q.name === p.name)));
      if (!b.category && b.superclass && !known.extends) known.extends = b.superclass;
      for (const p of b.protocols) if (!known.implements.includes(p)) known.implements.push(p);
      continue;
    }
    const cls: ClassInfo = {
      name: b.name, extends: b.category ? null : b.superclass, implements: b.protocols, decorators: [],
      methods: [], properties: props, isExported: true, line: b.line, endLine: b.endLine,
    };
    byName.set(b.name, cls);
    classes.push(cls);
  }
  return classes.sort((a, b) => a.line - b.line);
}

/** The lines of the method declarations inside `@interface` blocks: no function of the file. */
export function declarationLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  for (const b of blocksOf(lines)) {
    if (b.kind !== "interface") continue;
    for (let l = b.line; l <= b.endLine; l++) out.add(l);
  }
  return out;
}

function protocolMethods(lines: string[], b: Block): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  for (let i = b.line; i < b.endLine; i++) {
    const m = /^\s*[-+]\s*\([^)]*\)\s*(\w+)/.exec(lines[i]!);
    if (!m) continue;
    out.push({
      name: m[1]!, params: objcParams(lines, i) ?? [], returnType: parseObjcReturnType(lines[i]!), isAsync: false, isExported: true,
      decorators: [], calls: [], line: i + 1, endLine: i + 1,
    });
  }
  return out;
}
