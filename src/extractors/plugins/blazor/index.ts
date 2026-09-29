import type {
  RouteInfo,
  RouteParamInfo,
  SubComponentInfo,
  InteractiveElementInfo,
} from "../../../types/analysis.js";
import { applyRouteMeta, splitList, type GuardAttr } from "../../shared/route-metadata.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * Blazor `.razor` markup extraction (regex path).
 *
 * A `.razor` file is HTML-ish markup with Razor `@`-directives. Its C# logic
 * lives either in a `@code { }` block or — more commonly in component libraries
 * like DevToys — in a sibling `Foo.razor.cs` code-behind partial class (already
 * parsed by the C# plugin). So this spec extracts the UI half only:
 *
 *  - `@page "/route"`               → frontend routes (and therefore routed screens),
 *    with `{id:int}` tokens as route params (typed by the constraint, else by a
 *    same-named `[Parameter]` property), `[SupplyParameterFromQuery]`
 *    properties as query params, and `@attribute [Authorize(…)]` /
 *    `[AllowAnonymous]` as the page's `auth` (same reading as the C# plugin's)
 *  - `@using X.Y`                   → imports (namespace dependencies + framework hints)
 *  - PascalCase tags (`<Button …>`) → sub-components (the component-composition graph)
 *  - `@onclick`/`@bind`/native      → interactive elements
 *
 * Components, methods, and `@code` C# are intentionally NOT extracted here — the
 * code-behind `.razor.cs` owns them, and re-declaring the partial class would
 * collide. `@code` blocks and `@* … *@` comments are blanked before markup
 * scanning so C# generics (`Dictionary<String, …>`) inside them never read as
 * component tags.
 */

// ─── Markup isolation (blank out @code blocks + Razor comments) ─────────────

/**
 * Return a copy of `lines` with `@code`/`@functions` block bodies and
 * `@* … *@` comment spans replaced by blank lines, so component/element regexes
 * only ever see real markup. Line numbers are preserved (1:1 with the original).
 */
function markupOnly(lines: string[]): string[] {
  const out = lines.slice();
  let braceDepth = 0; // >0 while inside a @code/@functions body
  let inComment = false;
  for (let i = 0; i < out.length; i++) {
    let line = out[i] ?? "";

    // Multi-line Razor comment `@* … *@`.
    if (inComment) {
      const end = line.indexOf("*@");
      if (end < 0) {
        out[i] = "";
        continue;
      }
      line = line.slice(end + 2);
      inComment = false;
    }
    // Strip single-line and opening multi-line comments.
    line = line.replace(/@\*[\s\S]*?\*@/g, "");
    const open = line.indexOf("@*");
    if (open >= 0) {
      line = line.slice(0, open);
      inComment = true;
    }

    if (braceDepth > 0) {
      // Inside a code block: track braces, emit nothing.
      braceDepth += countChar(line, "{") - countChar(line, "}");
      if (braceDepth < 0) braceDepth = 0;
      out[i] = "";
      continue;
    }

    // Enter a code block on `@code {` / `@functions {`.
    const codeStart = line.match(/@(?:code|functions)\b/);
    if (codeStart) {
      const after = line.slice(codeStart.index! + codeStart[0].length);
      const opensHere = countChar(after, "{");
      out[i] = line.slice(0, codeStart.index!); // keep any markup before `@code`
      if (opensHere > 0) braceDepth = opensHere - countChar(after, "}");
      continue;
    }

    out[i] = line;
  }
  return out;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// ─── Routes (`@page`) ───────────────────────────────────────────────────────

const PAGE_RE = /^\s*@page\s+"([^"]+)"/;
/** `@attribute [Authorize(Roles = "Admin")]` / `@attribute [AllowAnonymous]`. */
const PAGE_ATTRIBUTE_RE = /^\s*@attribute\s+\[\s*([A-Za-z_][\w.]*)(?:Attribute)?\s*(\((?:[^()"]|"[^"]*"|\([^)]*\))*\))?\s*\]/;
/** `{id:int}`, `{slug?}`, `{*rest}` in a page template. */
const ROUTE_TOKEN_RE = /\{\*{0,2}([A-Za-z_]\w*)\??(?::([A-Za-z]+)[^}]*)?\}/g;
/** Route-constraint names as a type text (`{id:int}` → `int`); unknown constraints leave the type null. */
const CONSTRAINT_TYPES = new Set(["int", "guid", "long", "bool", "datetime", "decimal", "double", "float"]);
/** `[SupplyParameterFromQuery(Name = "q")] public string? Q { get; set; }` — attribute and property, same or adjacent lines. */
const PROPERTY_RE = /^\s*(?:public|internal|protected|private)?\s*(?:static\s+)?([A-Za-z_][\w.<>,\[\]?]*)\s+([A-Za-z_]\w*)\s*\{/;
const ATTR_RE = /\[\s*([A-Za-z_]\w*)(?:Attribute)?\s*(\([^)]*\))?\s*\]/g;

/** `Authorize(Roles = "A, B", Policy = "P", AuthenticationSchemes = "S")` → guard. */
function guardOf(name: string, args: string | undefined): GuardAttr | null {
  const simple = name.split(".").pop()!;
  const text = simple + (args ? args.replace(/\s+/g, " ") : "");
  if (simple === "AllowAnonymous") return { text, anonymous: true };
  if (simple !== "Authorize") return null;
  const named = (key: string): string | null => {
    const m = args?.match(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|nameof\\(([^)]*)\\)|([A-Za-z_][\\w.]*))`));
    return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
  };
  // `[Authorize("PolicyName")]` — the positional argument is the policy.
  const positional = args?.match(/^\(\s*"([^"]*)"/)?.[1] ?? null;
  return {
    text,
    policies: splitList(named("Policy") ?? positional),
    roles: splitList(named("Roles")),
    schemes: splitList(named("AuthenticationSchemes")),
  };
}

function pageGuards(lines: string[]): GuardAttr[] {
  const out: GuardAttr[] = [];
  for (const line of lines) {
    const m = PAGE_ATTRIBUTE_RE.exec(line);
    if (!m) continue;
    const g = guardOf(m[1]!, m[2]);
    if (g) out.push(g);
  }
  return out;
}

interface CodeProperty {
  name: string;
  type: string;
  attrs: Array<{ name: string; args: string | undefined }>;
}

/** Attributed properties in the file's C# (`@code` blocks) — read from the raw lines, before blanking. */
function codeProperties(lines: string[]): CodeProperty[] {
  const out: CodeProperty[] = [];
  let pending: CodeProperty["attrs"] = [];
  for (const line of lines) {
    const attrs: CodeProperty["attrs"] = [];
    for (const a of line.matchAll(ATTR_RE)) attrs.push({ name: a[1]!, args: a[2] });
    const rest = line.replace(ATTR_RE, "");
    const pm = PROPERTY_RE.exec(rest);
    if (pm && /\bget\b|\bset\b|\binit\b/.test(rest)) {
      out.push({ name: pm[2]!, type: pm[1]!, attrs: [...pending, ...attrs] });
      pending = [];
    } else if (attrs.length > 0 && rest.trim() === "") {
      pending.push(...attrs); // attributes on their own line above the property
    } else if (rest.trim() !== "") {
      pending = [];
    }
  }
  return out;
}

function pageParams(path: string, props: CodeProperty[]): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  const byName = new Map(props.map((p) => [p.name.toLowerCase(), p]));
  for (const m of path.matchAll(ROUTE_TOKEN_RE)) {
    const name = m[1]!;
    const constraint = m[2]?.toLowerCase();
    const bound = byName.get(name.toLowerCase());
    const boundType = bound?.attrs.some((a) => a.name === "Parameter") ? bound.type : null;
    out.push({ name, type: constraint && CONSTRAINT_TYPES.has(constraint) ? constraint : boundType, binding: "route" });
  }
  for (const p of props) {
    const q = p.attrs.find((a) => a.name === "SupplyParameterFromQuery");
    if (!q) continue;
    const named = q.args?.match(/\bName\s*=\s*"([^"]*)"/)?.[1];
    out.push({ name: named ?? p.name, type: p.type, binding: "query" });
  }
  return out;
}

function extractBlazorRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  let guards: GuardAttr[] | null = null;
  let props: CodeProperty[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(PAGE_RE);
    if (!m) continue;
    guards ??= pageGuards(lines);
    props ??= codeProperties(lines);
    const route: RouteInfo = {
      path: m[1]!,
      httpMethod: null,
      kind: "frontend",
      handler: null,
      // The page IS the screen — no separate component file to resolve to, so
      // the screen builder treats this as an inline route on the .razor itself.
      componentPath: null,
      calls: [],
      middleware: [],
      line: i + 1,
    };
    applyRouteMeta(route, { guards, params: pageParams(route.path, props) });
    routes.push(route);
  }
  return routes;
}

// ─── Sub-components (PascalCase tags) ───────────────────────────────────────

/** `<Foo`, `<Foo>`, `<Foo/>`, `<Foo Bar="x">` — the char after the name must be
 *  whitespace, `/`, or `>` so partial words and closing `</Foo>` don't match. */
const COMPONENT_TAG_RE = /<([A-Z][A-Za-z0-9_]*)(?=[\s/>])/g;
/** Razor/control tags that aren't real components. */
const NON_COMPONENT_TAGS = new Set(["DOCTYPE"]);

function extractBlazorSubComponents(lines: string[]): SubComponentInfo[] {
  const markup = markupOnly(lines);
  const byName = new Map<string, SubComponentInfo>();
  for (let i = 0; i < markup.length; i++) {
    const line = markup[i] ?? "";
    for (const m of line.matchAll(COMPONENT_TAG_RE)) {
      const name = m[1]!;
      if (NON_COMPONENT_TAGS.has(name)) continue;
      if (byName.has(name)) continue; // one entry per distinct component
      byName.set(name, {
        name,
        importSource: null, // Blazor resolves components by namespace, not file path
        props: attrNames(line.slice(m.index! + m[0].length)),
        line: i + 1,
      });
    }
  }
  return [...byName.values()];
}

/** Attribute names on the remainder of a tag's opening line (`Foo="x" @bind=…` → ["Foo"]). */
function attrNames(tagRest: string): string[] {
  const stop = tagRest.indexOf(">");
  const scope = stop >= 0 ? tagRest.slice(0, stop) : tagRest;
  const names: string[] = [];
  for (const m of scope.matchAll(/(?:^|\s)([A-Za-z][\w-]*)\s*=/g)) {
    const n = m[1]!;
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

// ─── Interactive elements (`@onclick`, `@bind`, native tags) ────────────────

const NATIVE_INTERACTIVE: Record<string, InteractiveElementInfo["element"]> = {
  button: "button",
  input: "input",
  select: "select",
  textarea: "textarea",
  form: "form",
  a: "link",
};

const EVENT_RE = /@on([a-z]+)\s*=\s*"([^"]*)"/g;
const BIND_RE = /@bind(?:-[A-Za-z]+)?\s*=\s*"([^"]*)"/g;
const OPEN_TAG_RE = /<([A-Za-z][\w]*)\b/g;

function elementForTag(tag: string | null): InteractiveElementInfo["element"] {
  if (!tag) return "custom";
  if (/^[A-Z]/.test(tag)) return "custom"; // a Blazor component
  return NATIVE_INTERACTIVE[tag.toLowerCase()] ?? "custom";
}

/** Pull a clean handler name from a directive value: a method call wins, then a
 *  bare member path; lambdas/expressions fall back to null. */
function cleanHandler(raw: string): string | null {
  const val = raw.trim().replace(/^@+/, "");
  const call = val.match(/([A-Za-z_]\w*)\s*\(/);
  if (call) return call[1]!;
  const ident = val.match(/^([A-Za-z_][\w.]*)$/);
  if (ident) return ident[1]!;
  return null;
}

function extractBlazorInteractiveElements(lines: string[]): InteractiveElementInfo[] {
  const markup = markupOnly(lines);
  const out: InteractiveElementInfo[] = [];
  let carriedTag: string | null = null; // last opened tag (carries across lines within a tag)
  for (let i = 0; i < markup.length; i++) {
    const line = markup[i] ?? "";
    const ln = i + 1;
    const tags = [...line.matchAll(OPEN_TAG_RE)];
    const tagAt = (idx: number): string | null => {
      let name = carriedTag;
      for (const t of tags) if (t.index! < idx) name = t[1]!;
      return name;
    };

    for (const ev of line.matchAll(EVENT_RE)) {
      out.push({
        element: elementForTag(tagAt(ev.index!)),
        event: "on" + ev[1]!,
        handler: cleanHandler(ev[2]!),
        line: ln,
      });
    }
    for (const b of line.matchAll(BIND_RE)) {
      out.push({
        element: elementForTag(tagAt(b.index!)) === "custom" ? "input" : elementForTag(tagAt(b.index!)),
        event: "bind",
        handler: cleanHandler(b[1]!),
        line: ln,
      });
    }

    if (tags.length > 0) carriedTag = tags[tags.length - 1]![1]!;
  }
  return out;
}

// ─── Imports (`@using`) ─────────────────────────────────────────────────────

export const blazorSpec: RegexLangSpec = {
  language: "blazor",
  extensions: [".razor"],
  blockStyle: "brace",
  lineCommentPrefixes: ["@*"],

  // The code-behind `.razor.cs` owns functions/classes; markup declares none.
  functionPatterns: [],
  classPatterns: [],

  importPatterns: [
    {
      // `@using Microsoft.AspNetCore.Components` / `@using static X.Y`
      pattern: /^\s*@using\s+(?:static\s+)?([A-Za-z_][\w.]*)/,
      getSource: (m) => m[1]!,
      getSpecifiers: () => [],
    },
  ],

  extractRoutes: (lines) => extractBlazorRoutes(lines),
  extractSubComponents: (lines) => extractBlazorSubComponents(lines),
  extractInteractiveElements: (lines) => extractBlazorInteractiveElements(lines),
};
