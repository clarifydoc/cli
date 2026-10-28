import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { extractClassesWithSpec, splitTopLevel, type CallPattern, type RegexLangSpec } from "../shared/regex-base.js";
import { extractWinFormsScreens } from "./winforms-screens.js";
import { extractVbDataSources } from "./data-sources.js";
import { extractVbRoutes } from "./routes.js";
import { readVbType, splitVbAttributes } from "./request-schema.js";
import {
  extractVbDiBindings,
  extractVbLocalTypes,
  vbCodeText,
  vbLogicalLines,
  vbParamQualifier,
  VB_LOOKUP_CALL_PATTERNS,
} from "./di.js";

/** Inline `<Attr>` lists at the start of a declaration line, as a regex source. */
const INLINE_ATTRS = String.raw`((?:<[^<>"]*(?:"[^"]*"[^<>"]*)*>\s*)*)`;

/** The attributes of an inline `<A> <B("x")>` prefix, split one per entry. */
function inlineAttributes(prefix: string): string[] {
  return [...prefix.matchAll(/<([^<>"]*(?:"[^"]*"[^<>"]*)*)>/g)].flatMap((m) => splitVbAttributes(m[1]!));
}

/**
 * VB block-end detection uses `Sub`/`End Sub`, `Function`/`End Function`, `Class`/`End Class`, etc.
 * The regex must consume whitespace between modifiers — otherwise `Private Async Sub` won't match.
 */
const VB_OPEN_RE = /^\s*(?:(?:Public|Private|Friend|Protected|Shared|Static|Partial|Async|Overrides|Overridable|Overloads|ReadOnly|WriteOnly|Default|MustOverride|NotOverridable|NotInheritable|MustInherit|Widening|Narrowing)\s+)*(Sub|Function|Property|Operator|Class|Module|Structure|Interface|Enum|Namespace|If|Select|While|With|For|Try|SyncLock|Using|Do)\b/i;
const VB_END_RE = /^\s*End\s+(Sub|Function|Property|Operator|Class|Module|Structure|Interface|Enum|Namespace|If|Select|While|With|For|Try|SyncLock|Using|Do)\b/i;

/**
 * The name the compiler gives an overloaded operator (`Operator +` →
 * `op_Addition`): `-` and `+` with one operand are the unary ones, and a
 * `CType` conversion is `op_Implicit` when `Widening`, else `op_Explicit`.
 */
const VB_OPERATOR_NAMES: Readonly<Record<string, string>> = {
  "+": "op_Addition", "-": "op_Subtraction", "*": "op_Multiply", "/": "op_Division", "\\": "op_IntegerDivision",
  "mod": "op_Modulus", "^": "op_Exponent", "&": "op_Concatenate", "=": "op_Equality", "<>": "op_Inequality",
  "<": "op_LessThan", ">": "op_GreaterThan", "<=": "op_LessThanOrEqual", ">=": "op_GreaterThanOrEqual",
  "<<": "op_LeftShift", ">>": "op_RightShift", "and": "op_BitwiseAnd", "or": "op_BitwiseOr", "xor": "op_ExclusiveOr",
  "not": "op_OnesComplement", "like": "op_Like", "istrue": "op_True", "isfalse": "op_False",
};

function vbOperatorName(written: string, line: string): string {
  const op = written.toLowerCase();
  if (op === "ctype") return /\bWidening\b/i.test(line) ? "op_Implicit" : "op_Explicit";
  if (op === "+" || op === "-") {
    const list = /Operator\s*[-+]\s*\(([^)]*)\)/i.exec(line)?.[1] ?? "";
    if (list.trim() !== "" && !list.includes(",")) return op === "+" ? "op_UnaryPlus" : "op_UnaryNegation";
  }
  return VB_OPERATOR_NAMES[op] ?? `op_${written}`;
}

/**
 * Words that open a VB statement which is not a call (declarations, control
 * flow, VB6 file I/O, LINQ clauses) — lowercase. See VB_STATEMENT_CALL.
 */
const VB_STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
  "addhandler", "aggregate", "and", "andalso", "async", "await", "call", "case", "catch", "class", "close",
  "const", "continue", "declare", "default", "delegate", "dim", "distinct", "do", "each", "else", "elseif",
  "end", "enum", "erase", "error", "event", "exit", "finally", "for", "friend", "from", "function", "get",
  "global", "gosub", "goto", "group", "handles", "if", "implements", "imports", "in", "inherits", "input",
  "interface", "into", "is", "isnot", "iterator", "join", "kill", "let", "line", "load", "lock", "loop", "me",
  "mod", "module", "mustinherit", "mustoverride", "mybase", "myclass", "namespace", "narrowing", "new",
  "next", "not", "nothing", "notinheritable", "notoverridable", "of", "on", "open", "operator", "option",
  "optional", "or", "order", "orelse", "overloads", "overridable", "overrides", "paramarray", "partial",
  "print", "private", "property", "protected", "public", "put", "raiseevent", "randomize", "readonly", "redim",
  "rem", "removehandler", "resume", "return", "seek", "select", "set", "shadows", "shared", "skip", "static",
  "step", "stop", "structure", "sub", "synclock", "take", "then", "throw", "to", "try", "type", "unload",
  "unlock", "until", "using", "wend", "when", "where", "while", "widening", "with", "withevents", "write",
  "writeonly", "xor", "yield",
]);

/**
 * A call written as a statement, without parentheses — `ProcessOrders conn`,
 * `Main`, `rs.MoveNext`, `Call Cleanup`. VB (every dialect) admits no
 * expression statement but a call or an assignment, so a statement that
 * opens with a name that is no keyword, and assigns nothing, calls it. That
 * is how VBScript and VB6 call almost every Sub; `Foo(x)` / `Call Foo(x)`
 * are the baseline's. A line continuing the one above is not a statement.
 */
const VB_STATEMENT_CALL: CallPattern = {
  // The name may not be a keyword — unless a member follows (`Me.Close`,
  // `Err.Raise`); after it comes the end of the line or an argument, never
  // an assignment, a binary operator, or a bare `_` (`builder _` continues
  // into `.UseX()` — a member chain, not a call of `builder`).
  pattern: new RegExp(
    String.raw`^\s*(?:Call\s+)?(?!(?:${[...VB_STATEMENT_KEYWORDS].join("|")})\b(?!\.))` +
      String.raw`([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)` +
      String.raw`(?=[ \t]*$|[ \t]+(?![+\-*\/\\^&<>]?=|(?:And|AndAlso|Or|OrElse|Xor|Is|IsNot|Like|Mod|Then|To|Step|As|In)\b|[+\-*\/\\^&<>]|_\s*$)\S)`,
    "i",
  ),
  notAfter: /(?:\s_|[,(&+\-*\/{=<>.]|\b(?:And|AndAlso|Or|OrElse|Xor|Is|IsNot|Like|Mod|Not|In|Of|As|To|Step|Handles|Implements|Into|Equals))\s*$/i,
  buildName: (m) => {
    const name = m[1]!;
    return { name, leafName: name.slice(name.lastIndexOf(".") + 1) };
  },
};

const vbBase: RegexLangSpec = {
  language: "vb",
  extensions: [".vb", ".bas", ".cls", ".frm", ".vbs"],
  blockStyle: "keyword-end",
  keywordEnd: { openRe: VB_OPEN_RE, endRe: VB_END_RE },
  // VB line comments: ' (tick) or REM keyword
  lineCommentPrefixes: ["'", "REM ", "rem "],
  // A VBScript file IS its top-level statements (cscript/wscript run them).
  topLevelCalls: /\.vbs$/i,

  // VB: `ClassName.method()` — shared static/instance access pattern — plus
  // container lookups and casts chained into a call, which carry the
  // receiver's type (`sp.GetRequiredService(Of IClock)().NowUtc()`).
  callPatterns: [
    ...VB_LOOKUP_CALL_PATTERNS,
    {
      pattern: /\b([A-Z]\w+)\.(\w+)\s*\(/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
    VB_STATEMENT_CALL,
  ],

  // VB: `name As Type` / `ByVal name As Type` / `Optional name As Type = default`
  // / `<FromBody> request As T`. A leading attribute list is skipped (it is
  // read by the route extractor), and the type keeps its generic arguments.
  // A keyed service parameter (`<FromKeyedServices("sms")> n As INotifier`)
  // carries its key as the parameter's `qualifier`.
  parseParam: (p) => {
    const trimmed = p.trim().replace(/^(?:<[^<>"]*(?:"[^"]*"[^<>"]*)*>\s*)+/, "");
    if (!trimmed) return null;
    const m = trimmed.match(/^(?:(?:ByVal|ByRef|Optional|ParamArray)\s+)*(\w+)(\s+As\s+)?/i);
    if (!m) return null;
    const type = m[2] ? readVbType(trimmed, m[0].length)?.type ?? null : null;
    const def = trimmed.match(/=\s*(.+)$/);
    const param: ParamInfo = { name: m[1]!, type, defaultValue: def ? def[1]!.trim() : null };
    const qualifier = vbParamQualifier(p);
    if (qualifier) param.qualifier = qualifier;
    return param;
  },

  // VB: `Private ReadOnly _svc As ServiceType` (fields) and
  // `<Required> Public Property Name As String` (auto-properties, the shape
  // every DTO has). Attributes sit inline or on the line above (`attributeLine`).
  propertyPatterns: [
    {
      pattern: new RegExp(String.raw`^\s*` + INLINE_ATTRS + String.raw`(Public|Private|Friend|Protected)\s+(?:(?:ReadOnly|Shared|WithEvents)\s+)*(\w+)\s+As\s+(?:New\s+)?`, "i"),
      build: (m, line) => {
        // Skip method / property / event / const declarations (they use the same start)
        if (/\b(Sub|Function|Property|Event|Const)\b/i.test(line)) return null;
        const visibility = m[2]!.toLowerCase();
        const prop: PropertyInfo = {
          name: m[3]!,
          type: readVbType(line, m[0].length)?.type ?? null,
          visibility: (["public", "private", "protected"].includes(visibility)
            ? visibility
            : "private") as "public" | "private" | "protected",
          isStatic: /\bShared\b/i.test(line),
          isReadonly: /\bReadOnly\b/i.test(line),
        };
        const attrs = inlineAttributes(m[1]!);
        if (attrs.length > 0) prop.decorators = attrs;
        return prop;
      },
    },
    {
      pattern: new RegExp(
        String.raw`^\s*` + INLINE_ATTRS +
          String.raw`(?:(Public|Private|Friend|Protected)\s+)?(?:(?:Protected\s+Friend|Shared|ReadOnly|WriteOnly|Overridable|Overrides|MustOverride|NotOverridable|Overloads|Shadows|Default)\s+)*Property\s+(\w+)(?:\(\))?\s+As\s+(?:New\s+)?`,
        "i",
      ),
      build: (m, line) => {
        const visibility = (m[2] ?? "Public").toLowerCase();
        const prop: PropertyInfo = {
          name: m[3]!,
          type: readVbType(line, m[0].length)?.type ?? null,
          visibility: (["public", "private", "protected"].includes(visibility)
            ? visibility
            : "private") as "public" | "private" | "protected",
          isStatic: /\bShared\b/i.test(line),
          isReadonly: /\bReadOnly\b/i.test(line),
        };
        const attrs = inlineAttributes(m[1]!);
        if (attrs.length > 0) prop.decorators = attrs;
        return prop;
      },
    },
  ],

  /** `<Required>` / `<JsonProperty("x")> _` on the line above a declaration. */
  attributeLine: { pattern: /^\s*<(.*)>\s*(?:_\s*)?$/ },

  functionPatterns: [
    {
      // Sub Foo() / Function Foo() As Type / Public Sub Foo / Private Function Foo
      // Covers VB.NET and VBA
      // `Function [Get](…)` escapes a keyword name with brackets.
      // Abstract (`MustOverride`) and interface members have no body; the
      // class post-pass below says so. VBScript and VB6 drop the empty
      // parentheses: `Sub Main`.
      pattern: /^\s*(?:<[^<>"]*(?:"[^"]*"[^<>"]*)*>\s*)*(?:(?:Public|Private|Friend|Protected|Shared|Static|Overrides|Overridable|Overloads|NotOverridable|MustOverride|Shadows|Partial|Iterator|Async)\s+)*(?:Sub|Function)\s+\[?([A-Za-z_]\w*)\]?(?=\s*(?:\(|'|$))/i,
      isExported: (line) => !/\b(Private|Friend)\b/i.test(line),
      isAsync: (line) => /\bAsync\b/i.test(line),
    },
    {
      // `Public Shared Operator +(a As Score, b As Score) As Score` … `End Operator`:
      // a method under the compiler's name, so the calls in its body are kept.
      pattern: /^\s*(?:<[^<>"]*(?:"[^"]*"[^<>"]*)*>\s*)*(?:(?:Public|Private|Friend|Protected|Shared|Overloads|Shadows|Widening|Narrowing)\s+)*Operator\s+(CType|IsTrue|IsFalse|Not|And|Or|Xor|Mod|Like|<<|>>|<>|<=|>=|[-+*\/\\^&=<>])\s*(?=\()/i,
      isExported: (line) => !/\b(Private|Friend)\b/i.test(line),
      keywordNames: true,
      rename: vbOperatorName,
    },
    {
      // Property Get/Set/Let Name()
      pattern: /^\s*(?:Public\s+|Private\s+|Friend\s+|Protected\s+|Shared\s+)*Property\s+(?:Get|Set|Let)\s+([A-Za-z_]\w*)/i,
      isExported: (line) => !/\b(Private|Friend)\b/i.test(line),
    },
  ],

  classPatterns: [
    {
      // Class Foo / Public MustInherit Class Foo / Partial Friend Class Foo / Module Foo.
      // `Inherits` / `Implements` follow on the next lines by convention, or
      // on the declaration line after a `:` — both are read by the post-pass.
      pattern: /^\s*(?:(?:Public|Private|Friend|Protected|Partial|MustInherit|NotInheritable|Shadows)\s+)*(?:Class|Module|Structure)\s+([A-Za-z_]\w*)/i,
      getExtends: (line) => declarationClauses(line).inherits[0] ?? null,
      getImplements: (line) => declarationClauses(line).implements,
    },
    {
      // A VB interface seeds the linker's interface → implementation map.
      pattern: /^\s*(?:(?:Public|Private|Friend|Protected|Partial|Shadows)\s+)*Interface\s+([A-Za-z_]\w*)/i,
      kind: "interface",
      getExtends: (line) => declarationClauses(line).inherits[0] ?? null,
      getImplements: (line) => declarationClauses(line).inherits.slice(1),
    },
  ],

  /**
   * Post-pass over the generic class extraction:
   *  - `Inherits Foo` / `Implements IA, IB` statements, which VB places on the
   *    lines right after the declaration (and only there — they must come
   *    before any member, so the scan stops at the first other statement);
   *  - members with no body — every interface member, `MustOverride` methods —
   *    end on their own line. The generic keyword-end scan would otherwise run
   *    on to the next `End Function` and adopt another member's lines as calls;
   *  - a `MustInherit` class with nothing but `MustOverride` members is an
   *    interface in all but name (no behaviour of its own; whatever inherits
   *    it is the implementation). One concrete member keeps it a class;
   *  - a field assigned from a keyed constructor parameter carries the key.
   */
  extractClasses: (lines, _fns) => {
    const classes = extractClassesWithSpec(lines, vbBase);
    for (const cls of classes) {
      readHeaderClauses(lines, cls);
      let abstractMembers = 0;
      for (const m of cls.methods) {
        const isAbstract = /\bMustOverride\b/i.test(vbCodeText(lines[m.line - 1] ?? ""));
        if (isAbstract) abstractMembers++;
        if (cls.kind === "interface" || isAbstract) bodyless(m);
      }
      if (
        cls.kind === undefined && abstractMembers > 0 && abstractMembers === cls.methods.length &&
        cls.properties.length === 0 && /\bMustInherit\b/i.test(vbCodeText(lines[cls.line - 1] ?? ""))
      ) {
        cls.kind = "interface";
      }
      keyedFieldsFromConstructor(lines, cls);
    }
    return classes;
  },

  importPatterns: [
    {
      // Imports System.IO  /  Imports Alias = System.IO
      // VB's `Imports` brings a namespace into scope — there's no explicit symbol list.
      // We keep specifiers empty to avoid false matches against file basenames.
      // The component graph resolver still matches the namespace path to directories.
      pattern: /^\s*Imports\s+(?:([A-Za-z_]\w*)\s*=\s*)?([A-Za-z_][\w.]*)/i,
      getSource: (m) => m[2],
      getSpecifiers: (m) => {
        if (m[1]) return [m[1]]; // explicit alias
        return []; // plain namespace import — no specifiers
      },
    },
  ],

  extractRoutes: (lines, classes) => extractVbRoutes(lines, classes, vbBase),

  extractScreens: extractWinFormsScreens,
  extractDataSources: extractVbDataSources,

  // Dependency injection (see di.ts): typed locals and container registrations.
  extractLocalTypes: extractVbLocalTypes,
  extractDiBindings: extractVbDiBindings,
};

/** `Inherits` / `Implements` statements of one header statement (`:`-separated), or null for any other statement. */
function headerClauses(code: string): { inherits: string[]; implements: string[] } | null {
  const out = { inherits: [] as string[], implements: [] as string[] };
  for (const part of code.split(/:(?!=)/)) {
    const stmt = part.replace(/\s+/g, " ").trim();
    if (stmt === "") continue;
    const m = stmt.match(/^(Inherits|Implements) (.+)$/i);
    if (!m) return null;
    const names = splitTopLevel(m[2]!).map((n) => n.trim()).filter(Boolean);
    (m[1]!.toLowerCase() === "inherits" ? out.inherits : out.implements).push(...names);
  }
  return out;
}

/** The clauses written on the declaration line itself after a `:` (`Public Class X : Implements IX`). */
function declarationClauses(line: string): { inherits: string[]; implements: string[] } {
  const code = vbCodeText(line);
  const colon = code.search(/:(?!=)/);
  return (colon >= 0 ? headerClauses(code.slice(colon + 1)) : null) ?? { inherits: [], implements: [] };
}

/**
 * `Inherits` / `Implements` statements on the lines after a declaration, up
 * to the first other statement (a `_` continuation or a trailing comma joins
 * lines). An interface's `Inherits IA, IB`: the first is `extends`, the rest
 * `implements`, as on its declaration line.
 */
function readHeaderClauses(lines: string[], cls: ClassInfo): void {
  const body = lines.slice(cls.line, Math.max(cls.line, cls.endLine - 1));
  for (const stmt of vbLogicalLines(body)) {
    // `#Region` / `#If` directives may sit anywhere, the header included.
    if (stmt.code.trimStart().startsWith("#")) continue;
    const clauses = headerClauses(stmt.code);
    if (!clauses) break;
    const inherits = [...clauses.inherits];
    if (!cls.extends && inherits.length > 0) cls.extends = inherits.shift()!;
    const implemented = cls.kind === "interface" ? [...inherits, ...clauses.implements] : clauses.implements;
    for (const name of implemented) if (!cls.implements.includes(name)) cls.implements.push(name);
  }
}

/**
 * `_sms = sms` / `Me._sms = sms` in a constructor whose `sms` parameter is
 * keyed (`<FromKeyedServices("sms")>`): the field holds that keyed service,
 * so it carries the same `qualifier`. Two constructors assigning different
 * keys to one field leave it unkeyed.
 */
function keyedFieldsFromConstructor(lines: string[], cls: ClassInfo): void {
  const keyed = new Map<string, string | null>();
  for (const ctor of cls.methods) {
    if (ctor.name.toLowerCase() !== "new" || !ctor.params.some((p) => p.qualifier)) continue;
    const body = lines.slice(ctor.line, Math.max(ctor.line, ctor.endLine - 1));
    for (const stmt of vbLogicalLines(body)) {
      for (const part of stmt.code.split(/:(?!=)/)) {
        const m = part.trim().match(/^(?:Me\.)?([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)$/i);
        if (!m) continue;
        const qualifier = ctor.params.find((p) => p.name.toLowerCase() === m[2]!.toLowerCase())?.qualifier;
        if (!qualifier) continue;
        // VB names are case-insensitive: `_Sms` and `_sms` are one field.
        const field = m[1]!.toLowerCase();
        const prev = keyed.get(field);
        keyed.set(field, prev === undefined || prev === qualifier ? qualifier : null);
      }
    }
  }
  for (const prop of cls.properties) {
    const qualifier = keyed.get(prop.name.toLowerCase());
    if (qualifier) prop.qualifier = qualifier;
  }
}

/** A member declared without a body (interface member, `MustOverride`): it spans its own line and calls nothing. */
function bodyless(m: FunctionInfo): void {
  m.endLine = m.line;
  m.calls = [];
  delete m.localTypes;
  delete m.requestAccess;
}

export const vbSpec: RegexLangSpec = vbBase;
