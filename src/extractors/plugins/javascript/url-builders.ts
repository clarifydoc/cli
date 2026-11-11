/**
 * Project-level resolution of URL-builder helper calls in frontend api-call URLs.
 *
 * Real Vue/React data layers funnel every request through a project-defined
 * helper that assembles the base + version + path:
 *
 *   // utils/uriUtils.ts
 *   export function requestUri(endpoint, version = 'v2') {
 *     return import.meta.env.VITE_API + '/api/' + version + '/institution/' + id + '/' + endpoint;
 *   }
 *   // some.service.ts
 *   axios.get(requestUri('teamtalk', 'v4'))   // → /api/v4/institution/{}/teamtalk
 *
 * The per-file extractor captures the helper's parameterized template
 * (`FunctionInfo.urlTemplate`) and the call site's api-call target verbatim
 * (`requestUri('teamtalk', 'v4')`, or `` `${requestUri(...)}/${id}` ``). This
 * pass builds a project-wide helper index and substitutes each call site's
 * literal arguments into the matching template, so the api-call carries a
 * concrete app-relative URL that {@link linkApiCallsToRoutes} can join to the
 * backend route. The helper definition and its call sites are almost always in
 * different files, so this must run after per-file analysis (it mirrors
 * `resolveRouterMounts` / `detectFileBasedRoutes`).
 *
 * Operates on the aggregated api-call list in memory; per-file JSON is untouched.
 */

import type { DataSourceInfo, FileAnalysis, FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../types/project.js";
// The quote/bracket-aware splitter and unquoter are shared with the symbolic
// value resolver (one copy instead of the three that used to exist).
import { splitTopLevel, unquote } from "../../shared/value-resolver.js";
import { escapeRegex } from "../shared/path-utils.js";
import { buildWrapperIndex } from "../../../core/wrapper-index.js";

interface UrlBuilder {
  /** Every distinct template the helper may return, primary first. */
  templates: string[];
  params: ParamInfo[];
}

type ApiCall = DataSourceInfo & { filePath: string };

/**
 * Resolve one call argument to a path fragment. A bare string/template literal
 * yields its content; a concatenation (`'trainings/' + x.externalId`) keeps
 * its literal segments and reduces each runtime part to a `{}` wildcard so the
 * path still matches a parameterized route. A single non-literal (a bare
 * variable holding the whole value) returns null so a parameter default can fill
 * in instead (e.g. a version arg).
 */
function argLiteral(raw: string): string | null {
  const parts = splitTopLevel(raw, "+");
  if (parts.length === 1) {
    const t = parts[0]!.trim();
    if (t.startsWith("'") || t.startsWith('"') || t.startsWith("`")) return unquote(t);
    return null; // single identifier/expression — unresolvable; use default
  }
  return parts
    .map((p) => {
      const t = p.trim();
      const isLit = t.startsWith("'") || t.startsWith('"') || t.startsWith("`");
      return isLit ? unquote(t) : "{}"; // runtime part → wildcard
    })
    .join("");
}

/**
 * Substitute a call's literal args into one template's `{param}` tokens.
 * Null when a parameter the template uses is passed as a bare variable with
 * no default (`APIUrl(url)`): the resulting URL would be all wildcard, and a
 * `/api/{}` says nothing about which route the call reaches — better to leave
 * the call unresolved than to let it join whatever `/api/:id` exists.
 */
function substitute(template: string, params: ParamInfo[], args: string[]): string | null {
  let out = template;
  // `{p?/}`: the joining slash a path argument that starts with one does not need.
  for (const [i, p] of params.entries()) {
    const marker = `{${p.name}?/}`;
    if (!out.includes(marker)) continue;
    const given = i < args.length ? argLiteral(args[i]!) : null;
    if (given === null) return null;
    out = out.split(marker).join(given.startsWith("/") ? "" : "/");
  }
  for (const [i, p] of params.entries()) {
    const token = `{${p.name}}`;
    if (!out.includes(token)) continue;
    const provided = i < args.length ? argLiteral(args[i]!) : null;
    // A `null`/`undefined`/`''` default is the absence of a value, never one to splice in.
    const fallback = p.defaultValue != null && !NULLISH.test(p.defaultValue.trim()) ? unquote(p.defaultValue) : null;
    let value = provided ?? fallback;
    // A variable argument stands for one path segment — when the template
    // stays specific without it: literal path follows it (`/documents/{}/notes/`),
    // or a base is still to resolve. In `/api/v2/institution/{}/{endpoint}`
    // the variable names the endpoint itself, and `{}` would join any route — unless the
    // parameter is named for a record's key (`sessionId`, `slug`): that is a value, never an endpoint.
    if (value === null && i < args.length && !NULLISH.test(args[i]!.trim()) && (specificWithout(out, token) || KEY_PARAM.test(p.name))) value = "{}";
    // A helper giving back the path it is handed (`(await origin()) + path`), handed a variable
    // (`fetch(await apiUrl(path))` in a request wrapper): that variable, a hole the wrapper's callers fill.
    if (value === null && template === token && /^[A-Za-z_$][\w$]*$/.test(args[i]?.trim() ?? "")) value = `\${${args[i]!.trim()}}`;
    if (value === null) return null;
    out = out.split(token).join(value);
  }
  return out;
}

const NULLISH = /^(?:null|undefined|''|""|``)$/;
/** A parameter holding a record's key: `id`, `sessionId`, `club_id`, `uuid`, `slug`. */
const KEY_PARAM = /^(?:id|uuid|guid|slug)$|(?:Id|_id|Uuid|Slug)$/;

/** `{ slug, host: this.url, kind: 'live' }` → its `key: value` pairs (shorthands name a runtime value: left out). */
function objectArgument(arg: string): Map<string, string> | null {
  if (!arg.startsWith("{") || !arg.endsWith("}")) return null;
  const out = new Map<string, string>();
  for (const part of splitTopLevel(arg.slice(1, -1), ",")) {
    const m = /^\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * A helper taking one destructured object (`({ host, slug }) => `${host}/${slug}/fixtures``):
 * each `${key}` the call states becomes its value — a literal's text, else the
 * expression as a hole the next pass resolves (`${this.url}`).
 */
function substituteNamed(template: string, values: ReadonlyMap<string, string>): string {
  return template.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (hole, key: string) => {
    const v = values.get(key);
    if (v === undefined) return hole;
    const lit = argLiteral(v);
    return lit ?? `\${${v}}`;
  });
}

function specificWithout(template: string, token: string): boolean {
  if (template.includes("${")) return true;
  const after = template.slice(template.indexOf(token) + token.length).replace(/\{[^}]*\}/g, "");
  return /[A-Za-z0-9]/.test(after);
}

/**
 * The templates a call means, by the arguments it passes. A helper that
 * appends optional parts (`if (id) url += `${id}/``) has one template per
 * combination; the call supplying `id` and `action` means the one using both
 * — not the bare collection URL, which would link it to the wrong route.
 */
function chooseTemplates(builder: UrlBuilder, args: string[]): string[] {
  const used = (tpl: string) => new Set(builder.params.filter((p) => tpl.includes(`{${p.name}}`)).map((p) => p.name));
  const universe = new Set(builder.templates.flatMap((t) => [...used(t)]));
  if (universe.size === 0 || builder.templates.length === 1) return builder.templates;
  const supplied = new Set(
    builder.params.filter((p, i) => universe.has(p.name) && i < args.length && !NULLISH.test(args[i]!.trim())).map((p) => p.name),
  );
  const exact = builder.templates.filter((t) => {
    const u = used(t);
    return u.size === supplied.size && [...u].every((n) => supplied.has(n));
  });
  return exact.length > 0 ? exact : builder.templates;
}

function templatesOf(fn: FunctionInfo): string[] {
  return fn.urlTemplate ? [fn.urlTemplate, ...(fn.urlTemplateAlternatives ?? [])] : [];
}

/**
 * Build the project-wide helper index over free functions AND class methods —
 * a data layer's helper is as often `configService.APIUrl(sub)` on a service
 * singleton as a bare `requestUri(sub)`. A name that maps to two genuinely
 * different template sets is ambiguous and dropped (set to null) so we never
 * resolve it the wrong way.
 */
interface HelperLookup {
  /** Helpers by bare name across the project; null = two different ones (ambiguous). */
  global: Map<string, UrlBuilder | null>;
  /** File-local helpers by their dotted name — a route table's `routes.tagsSlug`. */
  local: Map<string, Map<string, UrlBuilder>>;
  /** Free helpers by the file declaring them: the lexical (same-file) and import-resolved lookups. */
  byFile?: Map<string, Map<string, UrlBuilder | null>>;
  /** Free functions each file declares at all (template or not): a bare call to one is that one. */
  declared?: Map<string, Set<string>>;
  /** The project file an import in `file` binds `name` from, and the name that file declares; null when none resolves. */
  imported?: (file: string, name: string) => { file: string; exported: string } | null;
  /** `this.m(…)`: the method of that name along the calling class's chain. */
  method?: (file: string, line: number, name: string, getterOnly?: boolean) => UrlBuilder | null;
  /** `endPoints('profile').url`, `messages.update(id).url`: the URL a helper's descriptor or table entry states under that key. */
  descriptor?: (site: CallSite, receiver: string, name: string, args: string[], key: string, keyArgs: string[] | null) => string[] | null;
  /** `this.resource` seen from the calling class: the literal its chain states (a `super('clubs')` argument included), or null. */
  field?: (file: string, line: number, name: string) => string | null;
}

function buildFileIndex(analyses: FileAnalysis[]): Map<string, Map<string, UrlBuilder | null>> {
  const out = new Map<string, Map<string, UrlBuilder | null>>();
  for (const a of analyses) {
    if (a.language !== "typescript" && a.language !== "javascript") continue;
    const map = new Map<string, UrlBuilder | null>();
    for (const fn of a.functions) {
      const templates = templatesOf(fn);
      if (templates.length === 0 || fn.name.includes(".")) continue;
      // Two same-named declarations of one file (nested scopes) are not told apart here.
      map.set(fn.name, map.has(fn.name) ? null : { templates, params: fn.params });
    }
    if (map.size > 0) out.set(a.filePath, map);
  }
  return out;
}

function buildIndex(analyses: FileAnalysis[]): Map<string, UrlBuilder | null> {
  const index = new Map<string, UrlBuilder | null>();
  const blankMembers = new Set<string>();
  const statedByMember = new Set<string>();
  for (const a of analyses) {
    if (a.language !== "typescript" && a.language !== "javascript") continue;
    const members = new Set(a.classes.flatMap((c) => c.methods));
    const fns = [...a.functions, ...a.classes.flatMap((c) => c.methods)];
    for (const fn of fns) {
      const templates = templatesOf(fn);
      if (fn.name.includes(".")) continue;
      // A member of a class is judged with every same-named member: one that states no URL
      // makes `receiver.name(…)` unknown rather than the namesake that does.
      const isMember = members.has(fn);
      if (templates.length === 0) {
        // Only against a templated member: a free function of the same name is another lookup (the caller's file / import).
        if (isMember) {
          blankMembers.add(fn.name);
          if (statedByMember.has(fn.name)) index.set(fn.name, null);
        }
        continue;
      }
      if (isMember) {
        statedByMember.add(fn.name);
        if (blankMembers.has(fn.name)) index.set(fn.name, null);
      }
      const existing = index.get(fn.name);
      if (existing === undefined) {
        index.set(fn.name, { templates, params: fn.params });
      } else if (existing && existing.templates.join("\n") !== templates.join("\n")) {
        index.set(fn.name, null); // colliding name, divergent template → ambiguous
      }
    }
  }
  return index;
}

// `${ requestUri('x','v4') }` (template substitution) or a bare `requestUri('x','v4')`,
// either optionally behind a receiver chain (`configService.APIUrl('x')`,
// `this.api.url('x')`) that is consumed with the call — the receiver only
// names where the helper lives. The arg group allows one level of nested
// parens so a helper whose argument embeds another call —
// `requestUri(`x/${periodParams(p)}`, 'v1')` — is matched whole instead of
// truncating at the inner `)`.
const ARG = "((?:[^()]|\\([^()]*\\))*)";
const RECEIVER = "((?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*)";
const HELPER_CALL_RE = new RegExp(
  `\\$\\{\\s*${RECEIVER}([A-Za-z_$][\\w$]*)\\s*\\(${ARG}\\)\\s*\\}|${RECEIVER}([A-Za-z_$][\\w$]*)\\s*\\(${ARG}\\)`,
  "g",
);

/** Cap on the URL variants one call may fan out to (helpers nested in helpers). */
const MAX_VARIANTS = 8;

interface HelperOccurrence {
  start: number;
  end: number;
  /** The occurrence rewritten through each of the helper's templates. */
  rewrites: string[];
}

/** Where a call sits — which file's route tables and which class's methods it sees. */
interface CallSite {
  file: string;
  line: number;
}

/**
 * The helper a call names: a dotted helper of the call's own file
 * (`routes.tagsSlug(…)`), then — for `this.m(…)` — the method along the
 * calling class's chain, then a helper of that bare name anywhere (unless two
 * differ).
 */
function lookupHelper(lookup: HelperLookup, site: CallSite, receiver: string, name: string): UrlBuilder | null {
  const recv = receiver.replace(/\s+/g, "").replace(/\.$/, "");
  if (recv) {
    const local = lookup.local.get(site.file)?.get(`${recv}.${name}`);
    if (local) return local;
  }
  if (recv === "this" && lookup.method) {
    const own = lookup.method(site.file, site.line, name);
    if (own) return own;
  }
  // A bare call is the helper its own file declares, else the one its import names — never a
  // same-named helper of another file. Only a call no import resolves falls to the project-wide name.
  if (!recv && lookup.byFile) {
    const here = lookup.byFile.get(site.file)?.get(name);
    if (here) return here;
    if (here === undefined && lookup.declared?.get(site.file)?.has(name)) return null; // declared here, states no URL
    const from = lookup.imported?.(site.file, name);
    if (from) return lookup.byFile.get(from.file)?.get(from.exported) ?? null;
  }
  return lookup.global.get(name) ?? null;
}

// `${this.url}` — a read of a getter (or no-argument method body) the calling class defines.
const GETTER_READ_RE = /\$\{\s*this\s*\.\s*([A-Za-z_$][\w$]*)\s*\}/g;

// `endPoints('profile').url`, `messages.update(id).url`, `endPoints('pages').url(clubId)`: a key of
// what a helper call hands back — read in place, or as the whole `${…}` hole it fills.
const DESCRIPTOR_READ_RE = new RegExp(`${RECEIVER}([A-Za-z_$][\\w$]*)\\s*\\(${ARG}\\)\\s*\\.\\s*([A-Za-z_$][\\w$]*)(?:\\s*\\(${ARG}\\))?`, "g");

/** Split a call's argument text into its arguments. */
const argsOf = (text: string): string[] => splitTopLevel(text, ",").map((a) => a.trim()).filter((a) => a.length > 0);

/** A descriptor read in `text` the lookup resolves, spanning the `${…}` around it when it fills one. */
function descriptorRead(text: string, lookup: HelperLookup, site: CallSite): HelperOccurrence | null {
  if (!lookup.descriptor) return null;
  for (const m of text.matchAll(DESCRIPTOR_READ_RE)) {
    const rewrites = lookup.descriptor(site, m[1] ?? "", m[2]!, argsOf(m[3]!), m[4]!, m[5] === undefined ? null : argsOf(m[5]));
    if (!rewrites) continue;
    let start = m.index!;
    let end = start + m[0].length;
    const open = /\$\{\s*$/.exec(text.slice(0, start));
    const close = /^\s*\}/.exec(text.slice(end));
    if (open && close) {
      start = open.index;
      end += close[0].length;
    }
    return { start, end, rewrites };
  }
  return null;
}

// `${this.url.replace(this.resource, '')}callbacks/kit`, `this.url.replaceAll('clubs', 'kits')`: a getter's URL
// with a part taken out or swapped (a client building a sibling endpoint from its own base).
const GETTER_EDIT_RE = /(\$\{\s*)?\bthis\s*\.\s*([A-Za-z_$][\w$]*)(?=\s*\.\s*replace(?:All)?\s*\()/g;

/** One `.replace(search, replacement)` / `.replaceAll(…)`: the search is literal text or a hole of the template (`this.resource`). */
interface UrlEdit {
  all: boolean;
  search: { text: string } | { hole: string };
  replacement: string;
}

/** A string literal with nothing in it JavaScript would read as a pattern or a hole (`$&`, `${…}`, escapes). */
const PLAIN_LITERAL = /^(['"`])([^'"`$\\]*)\1$/;
/** A regex literal of plain characters (`/clubs/`, `/\/clubs/g`): the text it matches, and whether it is global. */
const PLAIN_REGEX = /^\/((?:[^\\/[\](){}.*+?^$|]|\\[/.\-_])+)\/(g?)$/;

/**
 * A getter read edited by `.replace`/`.replaceAll` calls, evaluated over each of the getter's
 * templates: `get url() { return `${this.baseUrl()}/${this.resource}` }` with
 * `this.url.replace(this.resource, '')` is `${this.baseUrl()}/`. Null when any edit cannot be
 * told: a search value the template does not show (a runtime value, or text a hole may hold).
 */
function editedGetterRead(text: string, lookup: HelperLookup, site: CallSite): HelperOccurrence | null {
  for (const m of text.matchAll(GETTER_EDIT_RE)) {
    const read = readEdits(text, m.index! + m[0].length);
    if (!read) continue;
    let end = read.end;
    if (m[1] !== undefined) {
      // The whole `${…}` hole: nothing else may follow the edits inside it.
      const close = /^\s*\}/.exec(text.slice(end));
      if (!close) continue;
      end += close[0].length;
    } else if (text.slice(0, m.index).trim() !== "" || text.slice(end).trim() !== "") {
      continue; // a bare expression is understood only as the whole URL
    }
    const getter = lookup.method!(site.file, site.line, m[2]!, true);
    if (!getter || getter.params.length > 0) continue;
    const field = (name: string) => lookup.field?.(site.file, site.line, name) ?? null;
    const rewrites = getter.templates.map((t) => applyEdits(t, read.edits, field));
    if (rewrites.some((r) => r === null)) continue;
    return { start: m.index!, end, rewrites: rewrites as string[] };
  }
  return null;
}

/** The `.replace(…)` / `.replaceAll(…)` chain starting at `from`, and where it ends. */
function readEdits(text: string, from: number): { edits: UrlEdit[]; end: number } | null {
  const edits: UrlEdit[] = [];
  let i = from;
  for (;;) {
    const m = /^\s*\.\s*(replace|replaceAll)\s*\(/.exec(text.slice(i));
    if (!m) break;
    const open = i + m[0].length;
    const close = closingParen(text, open);
    if (close < 0) return null;
    const args = argsOf(text.slice(open, close));
    const edit = args.length === 2 ? readEdit(m[1] === "replaceAll", args[0]!, args[1]!) : null;
    if (!edit) return null;
    edits.push(edit);
    i = close + 1;
  }
  return edits.length > 0 ? { edits, end: i } : null;
}

/** The index of the `)` closing the parenthesis opened just before `open` (strings and regex literals skipped), or -1. */
function closingParen(text: string, open: number): number {
  let depth = 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"' || ch === "`" || (ch === "/" && /[(,]\s*$/.test(text.slice(open - 1, i)))) {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

function readEdit(all: boolean, search: string, replacement: string): UrlEdit | null {
  const repl = PLAIN_LITERAL.exec(replacement)?.[2];
  if (repl === undefined) return null;
  const lit = PLAIN_LITERAL.exec(search)?.[2];
  if (lit) return { all, search: { text: lit }, replacement: repl };
  const re = PLAIN_REGEX.exec(search);
  if (re) {
    // `replaceAll` with a non-global regex throws: no URL.
    if (all && !re[2]) return null;
    return { all: all || re[2] === "g", search: { text: re[1]!.replace(/\\(.)/g, "$1") }, replacement: repl };
  }
  if (/^this\s*\.\s*[A-Za-z_$][\w$]*$/.test(search)) return { all, search: { hole: search.replace(/\s+/g, "") }, replacement: repl };
  return null;
}

/** A template as its literal runs and `${…}` holes (braces balanced). */
function templateParts(template: string): Part[] {
  const out: Part[] = [];
  let lit = "";
  for (let i = 0; i < template.length; i++) {
    if (template.startsWith("${", i)) {
      let depth = 0;
      let j = i + 1;
      for (; j < template.length; j++) {
        if (template[j] === "{") depth++;
        else if (template[j] === "}" && --depth === 0) break;
      }
      if (j < template.length) {
        if (lit) out.push({ hole: false, text: lit });
        lit = "";
        out.push({ hole: true, text: template.slice(i, j + 1) });
        i = j;
        continue;
      }
    }
    lit += template[i];
  }
  if (lit) out.push({ hole: false, text: lit });
  return out;
}

/**
 * The template with each edit applied, or null when one cannot be told. Text is looked for
 * in the template's literal runs; when it is in none and the template has holes, the fields
 * among them the class states (`${this.resource}` from `super('clubs')`) are filled in and it
 * is looked for again — a hole left may hold it at run time, so nothing is claimed. A field
 * search (`this.resource`) is the text the class states for it, or else, stated only at run
 * time, the template's own `${this.resource}`.
 */
function applyEdits(template: string, edits: UrlEdit[], field: (name: string) => string | null): string | null {
  let parts: Part[] | null = templateParts(template);
  const fill = (ps: Part[], only?: string): Part[] =>
    templateParts(ps.map((p) => {
      const name = p.hole ? /^\$\{\s*this\s*\.\s*([A-Za-z_$][\w$]*)\s*\}$/.exec(p.text)?.[1] : undefined;
      const value = name && (only === undefined || name === only) ? field(name) : null;
      return value ?? p.text;
    }).join(""));
  for (const edit of edits) {
    if ("hole" in edit.search) {
      const hole = edit.search.hole;
      const name = hole.slice("this.".length);
      const value = field(name);
      if (value) {
        parts = replaceText(fill(parts, name), value, edit);
      } else {
        const at = parts.flatMap((p, i) => (p.hole && p.text.slice(2, -1).replace(/\s+/g, "") === hole ? [i] : []));
        if (at.length === 0) return null;
        for (const i of edit.all ? at : at.slice(0, 1)) parts[i] = { hole: false, text: edit.replacement };
        parts = templateParts(parts.map((p) => p.text).join(""));
      }
    } else {
      parts = replaceText(parts, edit.search.text, edit) ?? replaceText(fill(parts), edit.search.text, edit);
    }
    if (!parts) return null;
  }
  return parts.map((p) => p.text).join("");
}

type Part = { hole: boolean; text: string };

function replaceText(parts: Part[], search: string, edit: UrlEdit): Part[] | null {
  const hits = parts.flatMap((p, i) => (!p.hole && p.text.includes(search) ? [i] : []));
  if (hits.length === 0) return parts.some((p) => p.hole) ? null : parts;
  const out = parts.map((p) => ({ ...p }));
  if (edit.all) for (const i of hits) out[i]!.text = out[i]!.text.split(search).join(edit.replacement);
  else out[hits[0]!]!.text = out[hits[0]!]!.text.replace(search, () => edit.replacement);
  return templateParts(out.map((p) => p.text).join(""));
}

/** A builder's templates with a call's arguments in; null when a bare-variable argument leaves one unresolved. */
function rewriteWith(builder: UrlBuilder, args: string[]): string[] | null {
  // A builder taking one object it destructures (`({ host, clubSlug }) => …`) is handed its values by name.
  const destructures = builder.params.length === 0 || (builder.params.length === 1 && builder.params[0]!.name.trimStart().startsWith("{"));
  const named = destructures && args.length === 1 ? objectArgument(args[0]!) : null;
  const rewrites = named
    ? builder.templates.map((tpl) => substituteNamed(tpl, named))
    : chooseTemplates(builder, args).map((tpl) => substitute(tpl, builder.params, args));
  return rewrites.some((r) => r === null) ? null : (rewrites as string[]);
}

/** The first helper call in `text` that the index can resolve, or null. */
function firstResolvable(text: string, lookup: HelperLookup, site: CallSite): HelperOccurrence | null {
  const read = text.includes(").") ? descriptorRead(text, lookup, site) : null;
  if (read) return read;
  if (lookup.method && text.includes("${this.")) {
    for (const m of text.matchAll(GETTER_READ_RE)) {
      const getter = lookup.method(site.file, site.line, m[1]!, true);
      if (!getter || getter.params.length > 0) continue;
      return { start: m.index!, end: m.index! + m[0].length, rewrites: getter.templates };
    }
  }
  if (lookup.method && text.includes("this.") && /\.\s*replace(?:All)?\s*\(/.test(text)) {
    const edited = editedGetterRead(text, lookup, site);
    if (edited) return edited;
  }
  for (const m of text.matchAll(HELPER_CALL_RE)) {
    const inTemplate = m[2] != null;
    const receiver = (inTemplate ? m[1] : m[4]) ?? "";
    const name = (inTemplate ? m[2] : m[5]) as string;
    const argsText = (inTemplate ? m[3] : m[6]) as string;
    const builder = lookupHelper(lookup, site, receiver, name);
    if (!builder) {
      // An unknown call wrapping a helper call (`route(routes.club(id), query)`): the helper inside.
      const argsStart = m.index! + m[0].indexOf("(") + 1;
      const inner = argsText.includes("(") ? firstResolvable(argsText, lookup, site) : null;
      if (inner) return { start: argsStart + inner.start, end: argsStart + inner.end, rewrites: inner.rewrites };
      continue; // unknown or ambiguous — leave verbatim
    }
    const rewrites = rewriteWith(builder, argsOf(argsText));
    if (!rewrites) continue; // a bare-variable arg — leave verbatim
    // Reached through a receiver (`this.matches.getReportUrl(id)`), the helper's own `this`
    // is that receiver: `${this.getResourceUrl(…)}` in its template is `${this.matches.getResourceUrl(…)}` here.
    const via = receiver.replace(/\s+/g, "").replace(/\.$/, "");
    const seen = via && via !== "this" ? (rewrites as string[]).map((r) => r.replace(/\$\{this\./g, `\${${via}.`)) : (rewrites as string[]);
    return { start: m.index!, end: m.index! + m[0].length, rewrites: seen };
  }
  return null;
}

/**
 * Rewrite every resolvable helper call inside one target string. A helper
 * with several templates fans the target out into one variant per template,
 * primary first; variants are deduplicated and capped at {@link MAX_VARIANTS}.
 */
function resolveTargets(target: string, lookup: HelperLookup, site: CallSite): string[] {
  let variants = [target];
  for (let pass = 0; pass < MAX_VARIANTS; pass++) {
    const next: string[] = [];
    let changed = false;
    for (const v of variants) {
      const occ = firstResolvable(v, lookup, site);
      if (!occ) {
        next.push(v);
        continue;
      }
      changed = true;
      for (const r of occ.rewrites) {
        const rewritten = v.slice(0, occ.start) + r + v.slice(occ.end);
        if (!next.includes(rewritten)) next.push(rewritten);
      }
    }
    variants = next.slice(0, MAX_VARIANTS);
    if (!changed) break;
  }
  return variants;
}

/**
 * Resolve URL-builder helper calls in every api-call target. Mutates the targets
 * in place (`target` = primary branch, `targetAlternatives` = the others) and
 * returns the number rewritten. No-op when the project defines no URL-builder
 * helpers.
 */
export function resolveUrlBuilders(apiCalls: ApiCall[], analyses: FileAnalysis[], ctx?: ProjectContext): number {
  const lookup: HelperLookup = { global: buildIndex(analyses), local: localHelpers(analyses) };
  keepHelperBases(lookup, analyses);
  lookup.byFile = buildFileIndex(analyses);
  if (ctx) {
    const wrappers = buildWrapperIndex(analyses, ctx.importIndex);
    lookup.imported = (file, name) => wrappers.importedFrom(file, name);
    lookup.method = methodResolver(ctx);
    lookup.field = fieldResolver(ctx);
    lookup.descriptor = descriptorResolver(analyses, ctx, lookup);
  }
  if (lookup.global.size === 0 && lookup.local.size === 0 && !lookup.method) return 0;
  let count = 0;
  for (const call of apiCalls) {
    if (call.kind !== "api-call" || !call.target) continue;
    // A helper call always has `(`; a getter read is `${this.x}`.
    if (!call.target.includes("(") && !(lookup.method && call.target.includes("${this."))) continue;
    const original = call.target;
    const [primary, ...rest] = resolveTargets(call.target, lookup, { file: call.filePath, line: call.line });
    if (primary !== undefined && primary !== call.target) {
      // A getter read a subclass overrides: what this class's getter says is not the value for the
      // subclass, which states its own — the written text is kept for `resolveSymbolicTargets`.
      if (ctx && lookup.method) {
        const below = overridingClasses(ctx, call.filePath, call.line, original);
        if (below.length > 0) {
          const by: Record<string, { target: string; alternatives?: string[] }> = {};
          for (const d of below) {
            const [t, ...alts] = resolveTargets(original, { ...lookup, method: methodResolver(ctx, d) }, { file: call.filePath, line: call.line });
            if (t !== undefined) by[d.cls.name] = { target: t, ...(alts.length > 0 ? { alternatives: alts } : {}) };
          }
          call.getterReads = { text: original, by };
        }
      }
      call.target = primary;
      if (rest.length > 0) call.targetAlternatives = rest;
      count++;
    }
  }
  return count;
}

/** The classes below the one holding the call, when one of them states a getter `text` reads (`${this.url}`). */
function overridingClasses(ctx: ProjectContext, file: string, line: number, text: string): ClassRef[] {
  const cls = classAt(ctx, file, line);
  if (!cls) return [];
  const names = [...text.matchAll(GETTER_READ_RE)].map((m) => m[1]!);
  const below = ctx.classes.descendants(cls);
  return names.length > 0 && below.some((d) => names.some((n) => d.cls.methods.some((x) => x.name === n) || d.cls.fieldValues?.[n] !== undefined)) ? below : [];
}

/** The innermost class holding a line. */
function classAt(ctx: ProjectContext, file: string, line: number): ClassRef | null {
  let cls: ClassRef | null = null;
  for (const ref of ctx.classes.classesIn(file)) {
    if (ref.cls.line <= line && line <= ref.cls.endLine && (!cls || ref.cls.line >= cls.cls.line)) cls = ref;
  }
  return cls;
}

/**
 * `this.<name>` seen from the class holding a line: the first value its chain states — a
 * literal, or a constructor parameter (`this.resource = resource`) followed down to the
 * literal the class below handed `super(…)`. Null for a value stated only at run time.
 */
function fieldResolver(ctx: ProjectContext): (file: string, line: number, name: string) => string | null {
  const paramIndex = (c: ClassRef, value: string): number => {
    const param = /^\$\{([\w$]+)\}$/.exec(value)?.[1];
    const ctor = param ? c.cls.methods.find((m) => m.name === "constructor") : undefined;
    return ctor ? ctor.params.findIndex((p) => p.name === param) : -1;
  };
  return (file, line, name) => {
    const cls = classAt(ctx, file, line);
    if (!cls) return null;
    const up = [cls, ...ctx.classes.ancestors(cls).flatMap((s) => (s.ref ? [s.ref] : []))];
    const k = up.findIndex((c) => c.cls.fieldValues?.[name] !== undefined);
    if (k < 0) return null;
    let value = up[k]!.cls.fieldValues![name]!;
    let index = paramIndex(up[k]!, value);
    for (let j = k - 1; j >= 0 && index >= 0; j--) {
      value = up[j]!.cls.superArgs?.[index] ?? "${}";
      index = paramIndex(up[j]!, value);
    }
    return value.includes("${") ? null : value;
  };
}

/**
 * A helper whose URL starts with ANOTHER helper's call (`` (slug) => `${groupBase(slug)}/fixtures` ``)
 * lost that base when its template was read; it is put back — its own parameters as
 * placeholders — when the call names a helper of the same file or the project, so the
 * next pass resolves it instead of the URL losing its prefix.
 */
function keepHelperBases(lookup: HelperLookup, analyses: FileAnalysis[]): void {
  for (const a of analyses) {
    if (a.language !== "typescript" && a.language !== "javascript") continue;
    for (const fn of a.functions) {
      const m = fn.urlTemplateBase ? /^((?:[A-Za-z_$][\w$]*\.)*)([A-Za-z_$][\w$]*)\(([^()]*)\)$/.exec(fn.urlTemplateBase.trim()) : null;
      if (!m || m[2] === fn.name.split(".").pop() || lookupHelper(lookup, { file: a.filePath, line: fn.line }, m[1]!, m[2]!) === null) continue;
      let base = fn.urlTemplateBase!.trim();
      for (const p of fn.params) base = base.replace(new RegExp(`(?<![\\w$.{])${escapeRegex(p.name)}(?![\\w$}])`, "g"), `{${p.name}}`);
      const builder = fn.name.includes(".") ? lookup.local.get(a.filePath)?.get(fn.name) : lookup.global.get(fn.name);
      if (!builder || builder.templates.some((t) => t.startsWith("${"))) continue;
      builder.templates = builder.templates.map((t) => `\${${base}}${t}`);
    }
  }
}

/** Each file's dotted helpers (`routes.tagsSlug: (tag) => `${prefix}/tags/slug/${tag}``). */
function localHelpers(analyses: FileAnalysis[]): Map<string, Map<string, UrlBuilder>> {
  const out = new Map<string, Map<string, UrlBuilder>>();
  for (const a of analyses) {
    for (const fn of a.functions) {
      if (!fn.name.includes(".")) continue;
      const templates = templatesOf(fn);
      if (templates.length === 0) continue;
      const map = out.get(a.filePath) ?? new Map<string, UrlBuilder>();
      map.set(fn.name, { templates, params: fn.params });
      out.set(a.filePath, map);
    }
  }
  return out;
}

/**
 * `this.m(…)` → the first `m` along the calling class's chain, with its
 * templates (or nothing when it has none). A template whose leading runtime
 * base the extractor dropped (`${this.baseUrl()}/${this.resource}`) gets that
 * base back, so the next pass resolves it through the same chain instead of
 * the URL losing its prefix. `getterOnly` answers a property read (`this.url`):
 * only a getter is read that way.
 */
function methodResolver(ctx: ProjectContext, fixed?: ClassRef): (file: string, line: number, name: string, getterOnly?: boolean) => UrlBuilder | null {
  return (file, line, name, getterOnly) => {
    const cls = fixed ?? classAt(ctx, file, line);
    if (!cls) return null;
    for (const c of [cls, ...ctx.classes.ancestors(cls).flatMap((s) => (s.ref ? [s.ref] : []))]) {
      const fn = c.cls.methods.find((m) => m.name === name);
      if (!fn) {
        // A field of that name shadows nothing further up for a property read.
        if (getterOnly && c.cls.properties?.some((p) => p.name === name)) return null;
        continue;
      }
      // No getter flag is kept; a property read of a method only makes sense for one.
      if (getterOnly && fn.params.length > 0) return null;
      const templates = templatesOf(fn).map((t) => (fn.urlTemplateBase ? `\${${fn.urlTemplateBase}}${t}` : t));
      return templates.length > 0 ? { templates, params: fn.params } : null;
    }
    return null;
  };
}

/**
 * `endPoints('profile').url` / `messages.update(id).url`: the helper the call names — a
 * function of the module the name (or the object holding it) is imported from, that
 * module's anonymous default, or one of the call's own file — and what it states under
 * the key read:
 *
 *   - a request descriptor (`(id) => ({ url: `/api/v1/messages/${id}` })`): the
 *     descriptor's templates with the call's arguments in, when the key read is its URL key;
 *   - a table entry (`(page) => endPoints[page]`): the value the module states for
 *     `endPoints.<the literal argument>.<key>` — or, for a key called
 *     (`endPoints('pages').url(clubId)`), that entry's own URL helper with those arguments.
 *
 * A name the imports do not resolve falls back to the one descriptor helper of that name
 * in the project. Anything else resolves nothing.
 */
function descriptorResolver(analyses: FileAnalysis[], ctx: ProjectContext, lookup: HelperLookup): NonNullable<HelperLookup["descriptor"]> {
  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  const unique = new Map<string, { a: FileAnalysis; fn: FunctionInfo } | null>();
  for (const a of analyses) {
    if (a.language !== "typescript" && a.language !== "javascript") continue;
    for (const fn of a.functions) {
      if (!fn.requestDescriptor || fn.name.includes(".")) continue;
      unique.set(fn.name, unique.has(fn.name) ? null : { a, fn });
    }
  }
  type Entry = { table: string; param: string };
  const helperOf = (site: CallSite, receiver: string, name: string): { a: FileAnalysis; fn?: FunctionInfo; entryOf?: Entry; paramIndex: number } | null => {
    const recv = receiver.replace(/\s+/g, "").replace(/\.$/, "");
    if (recv.includes(".") || recv === "this") return null;
    const own = byFile.get(site.file);
    const source = ctx.importIndex.localFor(site.file, recv || name);
    const holder = source ? byFile.get(source) : recv ? undefined : own;
    if (holder) {
      const fn = holder.functions.find((f) => f.name === name && (f.requestDescriptor || f.returnsEntryOf));
      if (fn) return { a: holder, fn, entryOf: fn.returnsEntryOf, paramIndex: fn.returnsEntryOf ? fn.params.findIndex((p) => p.name === fn.returnsEntryOf!.param) : -1 };
      // `import endPoints from './endPoints'`: the module's anonymous default.
      const def = !recv && source ? holder.exports.find((e) => e.kind === "default") : undefined;
      if (def?.returnsEntryOf) return { a: holder, entryOf: def.returnsEntryOf, paramIndex: 0 };
      if (source) return null;
    }
    const only = unique.get(name);
    return only ? { a: only.a, fn: only.fn, paramIndex: -1 } : null;
  };
  return (site, receiver, name, args, key, keyArgs) => {
    const helper = helperOf(site, receiver, name);
    if (!helper) return null;
    if (helper.fn?.requestDescriptor) {
      const d = helper.fn.requestDescriptor;
      return d.key === key && keyArgs === null ? rewriteWith({ templates: d.urlTemplates, params: helper.fn.params }, args) : null;
    }
    if (!helper.entryOf || helper.paramIndex < 0) return null;
    const lit = args[helper.paramIndex];
    const entry = lit && /^(['"`])([A-Za-z_$][\w$]*)\1$/.exec(lit)?.[2];
    if (!entry) return null;
    const path = `${helper.entryOf.table}.${entry}.${key}`;
    if (keyArgs === null) {
      const value = helper.a.moduleValues?.[path];
      return value !== undefined && !value.includes("${") ? [value] : null;
    }
    const inner = lookup.local.get(helper.a.filePath)?.get(path);
    return inner ? rewriteWith(inner, keyArgs) : null;
  };
}
