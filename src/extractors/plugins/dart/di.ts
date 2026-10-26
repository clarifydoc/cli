import type { CallInfo, DiBinding, FunctionInfo } from "../../../types/analysis.js";
import type { CallPattern } from "../shared/regex-base.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { escapeRegex } from "../shared/path-utils.js";

/**
 * Dependency injection as Dart/Flutter code spells it — get_it (and kiwi,
 * GetX) registrations and lookups, injectable's annotations and generated
 * `gh.*` calls, provider's `Provider<I>(create: …)`, Riverpod providers and
 * their overrides. Facts only: the linker decides which implementation a
 * call reaches (see `DiBinding`).
 */

// ─── Text helpers ──────────────────────────────────────────────────────────

/** A line with string contents and the trailing `//` comment blanked, same length. */
export function codeOf(line: string): string {
  const code = blankStringLiterals(line);
  const comment = code.indexOf("//");
  return comment < 0 ? code : code.slice(0, comment) + " ".repeat(code.length - comment);
}

/** Index just past the bracket that closes the one at `open`, or -1. */
export function closeOf(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  if (!pairs[code[open]!]) return -1;
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(" || c === "{" || c === "[") stack.push(pairs[c]!);
    else if (c === ")" || c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Up to `span` lines from `i`, raw and code-only, joined so their columns align. */
function window(lines: string[], i: number, span = 30): { raw: string; code: string } {
  const slice = lines.slice(i, Math.min(lines.length, i + span));
  return { raw: slice.join("\n"), code: slice.map(codeOf).join("\n") };
}

/** Split argument text at depth-0 commas, raw and code copies aligned. */
function splitArgs(code: string, raw: string): Array<{ code: string; raw: string }> {
  const out: Array<{ code: string; raw: string }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth = Math.max(0, depth - 1);
    if (i === code.length || (c === "," && depth === 0)) {
      if (code.slice(start, i).trim()) out.push({ code: code.slice(start, i), raw: raw.slice(start, i) });
      start = i + 1;
    }
  }
  return out;
}

interface Args {
  positional: Array<{ code: string; raw: string }>;
  named: Map<string, { code: string; raw: string }>;
}

function readArgs(code: string, raw: string): Args {
  const out: Args = { positional: [], named: new Map() };
  for (const a of splitArgs(code, raw)) {
    const label = a.code.match(/^\s*([A-Za-z_$]\w*)\s*:(?!:)/);
    if (label) out.named.set(label[1]!, { code: a.code.slice(label[0].length), raw: a.raw.slice(label[0].length) });
    else out.positional.push(a);
  }
  return out;
}

/** `'mem'` / `"mem"` → mem; any other expression as written (it then only matches the same spelling). */
function keyValue(raw: string): string {
  const t = raw.trim();
  const str = t.match(/^r?(['"])(.*)\1$/s);
  return str ? str[2]! : t.replace(/\s+/g, " ");
}

/** `Repo<User>` / `prefix.Repo` / `Repo?` → `Repo`. */
function bareType(t: string): string {
  return t.trim().replace(/\?$/, "").replace(/<.*$/s, "").split(".").pop()!.trim();
}

/** Split `<A, B<C>>` (without the outer brackets) into its type arguments. */
function typeArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === "<") depth++;
    else if (c === ">") depth--;
    if (i === text.length || (c === "," && depth === 0)) {
      if (text.slice(start, i).trim()) out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return out;
}

/** A balanced generic clause `<…>` starting at `open`, or -1. */
function closeAngle(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "<") depth++;
    else if (c === ">" && --depth === 0) return i + 1;
    else if (c === ";" || c === "{" || c === "(" || c === ")") return -1;
  }
  return -1;
}

// ─── What an expression constructs ─────────────────────────────────────────

/** Nested generic arguments, as a regex fragment. */
const GENERIC = String.raw`<[^<>()]*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>[^<>()]*)*>`;

/**
 * `PgRepo(…)` / `const PgRepo()` / `Repo<User>(…)` / `http.Client()` /
 * `PgRepo.new(…)`, optionally followed by cascades, and nothing else — the
 * type as written (generic arguments kept) and its bare name. A named
 * constructor `Foo.bar()` is not read: it cannot be told from a static method
 * returning something else.
 */
export function constructionOf(text: string): { type: string; impl: string } | null {
  const head = text.match(new RegExp(String.raw`^\s*(?:const\s+|new\s+)?(?:[a-z_]\w*\s*\.\s*)?([A-Z]\w*)\s*(${GENERIC})?\s*(?:\.\s*new\s*)?\(`));
  if (!head) return null;
  const end = closeOf(text, head[0].length - 1);
  if (end < 0) return null;
  const rest = text.slice(end).replace(/;\s*$/, "").trim();
  if (rest !== "" && !rest.startsWith("..")) return null;
  return { type: head[1]! + (head[2] ?? ""), impl: head[1]! };
}

/**
 * The class a factory argument produces: a construction, a constructor
 * tear-off (`PgRepo.new`), or a closure returning one (`() => PgRepo()`,
 * `(c) async => PgRepo(c.get())`, `(_) { return PgRepo(); }`).
 */
export function productOf(expr: string): string | null {
  let text = expr.trim();
  const tearOff = text.match(/^(?:[a-z_]\w*\s*\.\s*)?([A-Z]\w*)(?:<[^()]*>)?\s*\.\s*new$/);
  if (tearOff) return tearOff[1]!;
  const lambda = text.match(/^\(([^()]*)\)\s*(?:async\s*)?(=>|\{)/);
  if (lambda) {
    if (lambda[2] === "=>") text = text.slice(lambda[0].length);
    else {
      const open = lambda[0].length - 1;
      if (closeOf(text, open) !== text.length) return null;
      const ret = text.slice(open + 1, -1).trim().match(/^return\s+([\s\S]+?);?$/);
      if (!ret) return null;
      text = ret[1]!;
    }
  }
  return constructionOf(text)?.impl ?? null;
}

// ─── Registrations ─────────────────────────────────────────────────────────

/** get_it (and kiwi) registration methods; the instance or factory is the first positional argument. */
const REGISTER_RE =
  /(?:\.\.|\.)\s*(register(?:Singleton|LazySingleton|Factory|SingletonAsync|LazySingletonAsync|FactoryAsync|FactoryParam|FactoryParamAsync|SingletonWithDependencies|CachedFactory|CachedFactoryParam|FactoryCached|FactoryCachedParam|Instance))\s*(?=[<(])/g;

/** injectable's generated `gh.lazySingleton<I>(() => T(…))` (in `*.config.dart`). */
const GH_RE =
  /\bgh\s*\.\s*(singleton|lazySingleton|factory|factoryParam|factoryCached|factoryCachedParam|singletonAsync|lazySingletonAsync|factoryAsync|factoryParamAsync|singletonWithDependencies)\s*(?=[<(])/g;

/** GetX `Get.put<I>(T())` / `Get.lazyPut<I>(() => T())`. */
const GETX_RE = /\bGet\s*\.\s*(put|lazyPut|putAsync|create|replace|lazyReplace)\s*(?=[<(])/g;

/** provider / flutter_bloc widgets whose `create:` / `value:` provides the type argument. */
const PROVIDER_WIDGET_RE = /\b(Provider|ChangeNotifierProvider|ListenableProvider|RepositoryProvider|InheritedProvider)\s*(?=<)/g;

/** Riverpod providers whose `ref.read(p)` / `ref.watch(p)` is the created object itself. */
const RIVERPOD_DECL_RE =
  /^\s*(?:final|const|var)\s+([A-Za-z_$]\w*)\s*=\s*(Provider|ChangeNotifierProvider|StateNotifierProvider|NotifierProvider|AsyncNotifierProvider)((?:\s*\.\s*(?:autoDispose|family))*)\s*(?=[<(])/;

/**
 * A call `<method><TypeArgs>(args)` at `at` (the method name's index): its
 * type arguments and arguments, or null when they do not parse.
 */
function callAt(code: string, raw: string, at: number): { types: string[]; args: Args; end: number } | null {
  let k = at;
  while (k < code.length && /[\w$]/.test(code[k]!)) k++;
  while (/\s/.test(code[k] ?? "")) k++;
  let types: string[] = [];
  if (code[k] === "<") {
    const close = closeAngle(code, k);
    if (close < 0) return null;
    types = typeArgs(code.slice(k + 1, close - 1));
    k = close;
    while (/\s/.test(code[k] ?? "")) k++;
  }
  if (code[k] === "." ) {
    // `Provider<I>.value(` — the constructor name follows the type arguments.
    const named = code.slice(k).match(/^\.\s*([A-Za-z_$]\w*)\s*/);
    if (!named) return null;
    k += named[0].length;
  }
  if (code[k] !== "(") return null;
  const end = closeOf(code, k);
  if (end < 0) return null;
  return { types, args: readArgs(code.slice(k + 1, end - 1), raw.slice(k + 1, end - 1)), end };
}

function binding(service: string, implementation: string, line: number, via: string, qualifier?: string): DiBinding | null {
  if (service === implementation && !qualifier) return null;
  const b: DiBinding = { service, implementation, line, via };
  if (qualifier) {
    b.qualifier = qualifier;
    b.keyedOnly = true;
  }
  return b;
}

/** A registration whose service is a token (a Riverpod provider variable), asked for by that token only. */
function tokenBinding(token: string, implementation: string, line: number, via: string): DiBinding {
  return { service: token, implementation, line, via, keyedOnly: true };
}

/**
 * A locator registration (`registerSingleton<I>(T())`, `gh.factory<I>(() =>
 * T())`, `Get.lazyPut<I>(() => T())`): the service is the first type
 * argument (else the product itself), the key is `instanceName:` (get_it),
 * `name:` (kiwi) or `tag:` (GetX).
 */
function locatorRegistration(lines: string[], i: number, at: number, via: string): DiBinding | null {
  const { raw, code } = window(lines, i, 20);
  const call = callAt(code, raw, at);
  if (!call || call.args.positional.length === 0) return null;
  const impl = productOf(call.args.positional[0]!.code);
  if (!impl) return null;
  const key = call.args.named.get("instanceName") ?? call.args.named.get("name") ?? call.args.named.get("tag");
  const service = call.types[0] ? bareType(call.types[0]) : impl;
  return binding(service, impl, i + 1, via, key ? keyValue(key.raw) : undefined);
}

/** `Provider<I>(create: (_) => T())` / `Provider<I>.value(value: T())`. */
function providerWidget(lines: string[], i: number, at: number, via: string): DiBinding | null {
  const { raw, code } = window(lines, i, 20);
  const call = callAt(code, raw, at);
  if (!call || !call.types[0]) return null;
  const create = call.args.named.get("create") ?? call.args.named.get("value");
  if (!create) return null;
  const impl = productOf(create.code);
  return impl ? binding(bareType(call.types[0]), impl, i + 1, via) : null;
}

/**
 * Riverpod `final repoProvider = Provider<UserRepo>((ref) => PgRepo());` — the
 * provider variable is the token `ref.read(repoProvider)` asks for, so the
 * binding is keyed by it alone.
 */
function riverpodProvider(lines: string[], i: number): DiBinding | null {
  const decl = codeOf(lines[i]!).match(RIVERPOD_DECL_RE);
  if (!decl) return null;
  const { raw, code } = window(lines, i, 20);
  // The call starts at the last segment: `Provider.autoDispose.family<…>(`.
  const call = callAt(code, raw, decl.index! + decl[0].search(/[A-Za-z_$]\w*\s*$/));
  const factory = call?.args.positional[0];
  if (!call || !factory || call.args.named.size > 0) return null;
  const impl = productOf(factory.code);
  return impl ? tokenBinding(decl[1]!, impl, i + 1, decl[2]!) : null;
}

/** `repoProvider.overrideWithValue(MemRepo())` / `.overrideWith((ref) => MemRepo())`. */
function riverpodOverrides(lines: string[], i: number, out: DiBinding[]): void {
  const line = codeOf(lines[i]!);
  for (const m of line.matchAll(/\b([A-Za-z_$]\w*)\s*\.\s*(overrideWithValue|overrideWith)\s*\(/g)) {
    const { raw, code } = window(lines, i, 10);
    const open = m.index! + m[0].length - 1;
    const end = closeOf(code, open);
    if (end < 0) continue;
    const args = readArgs(code.slice(open + 1, end - 1), raw.slice(open + 1, end - 1));
    const impl = args.positional.length === 1 ? productOf(args.positional[0]!.code) : null;
    if (impl) out.push(tokenBinding(m[1]!, impl, i + 1, m[2]!));
  }
}

/** The annotation block directly above line `i` plus the line's own leading annotations, joined. */
function annotationsAbove(lines: string[], i: number): string {
  const own = codeOf(lines[i]!).match(/^\s*((?:@[\w.]+(?:\s*\([^)]*\))?\s*)*)/)?.[1] ?? "";
  const parts: string[] = [];
  for (let j = i - 1; j >= 0 && i - j <= 12; j--) {
    if (lines[j]!.trimStart().startsWith("//")) continue; // doc comments sit between annotations
    const t = codeOf(lines[j]!).trim();
    if (t === "" || /[;{}]$/.test(t)) break;
    parts.unshift(t);
  }
  return parts.join(" ") + " " + own;
}

/** `@Named('x')` / `@named` (the class's own name) among annotations. */
function namedQualifier(annotations: string, rawAnnotations: string, className: string): string | undefined {
  const m = rawAnnotations.match(/@Named\s*\(\s*(r?(['"])[^'"]*\2|[^)]*)\s*\)/);
  if (m) return keyValue(m[1]!);
  if (/@named\b/.test(annotations)) return className;
  return undefined;
}

const INJECTABLE_ANN_RE = /@(LazySingleton|Singleton|Injectable)\s*\(/;

/**
 * injectable on a class: `@LazySingleton(as: UserRepo)` / `@Singleton(as: I)`
 * / `@Injectable(as: I)` → {I → the class}. An `env:` list still registers it
 * — two environment-specific implementations disagree and the linker refuses
 * to choose. `@Named('x')` keys it.
 */
function injectableClass(lines: string[], i: number, className: string): DiBinding | null {
  const annotations = annotationsAbove(lines, i);
  const rawAnnotations = rawAnnotationsAbove(lines, i);
  const ann = annotations.match(INJECTABLE_ANN_RE);
  const bare = /@(?:lazySingleton|singleton|injectable)\b/.test(annotations);
  if (!ann && !bare) return null;
  let service = className;
  if (ann) {
    const open = ann.index! + ann[0].length - 1;
    const end = closeOf(annotations, open);
    if (end < 0) return null;
    const as = readArgs(annotations.slice(open + 1, end - 1), annotations.slice(open + 1, end - 1)).named.get("as");
    if (as) service = bareType(as.code);
  }
  return binding(service, className, i + 1, ann ? `@${ann[1]}` : "@injectable", namedQualifier(annotations, rawAnnotations, className));
}

function rawAnnotationsAbove(lines: string[], i: number): string {
  const parts: string[] = [];
  for (let j = i - 1; j >= 0 && i - j <= 12; j--) {
    if (lines[j]!.trimStart().startsWith("//")) continue;
    const t = codeOf(lines[j]!).trim();
    if (t === "" || /[;{}]$/.test(t)) break;
    parts.unshift(lines[j]!.trim());
  }
  return parts.join(" ") + " " + lines[i]!;
}

/**
 * A module member (`@module abstract class RegisterModule`): `@lazySingleton
 * UserRepo get repo => PgRepo();` → {UserRepo → PgRepo} (`as:` overrides the
 * declared type), and a Riverpod generator function `@riverpod UserRepo
 * userRepo(Ref ref) => PgRepo();` → {userRepoProvider → PgRepo}.
 */
function annotatedFactory(lines: string[], i: number): DiBinding | null {
  const code = codeOf(lines[i]!);
  const m = code.match(
    new RegExp(String.raw`^\s*(?:@[\w.]+(?:\s*\([^)]*\))?\s*)*([A-Za-z_$][\w$.]*(?:${GENERIC})?\??)\s+(?:(get)\s+)?([A-Za-z_$]\w*)\s*(\([^()]*\))?\s*(?:async\s*)?=>\s*(.+?)\s*;?\s*$`),
  );
  if (!m) return null;
  const impl = constructionOf(m[5]!)?.impl;
  if (!impl) return null;
  const annotations = annotationsAbove(lines, i);
  if (/@(?:riverpod|Riverpod)\b/.test(annotations) && !m[2]) {
    return tokenBinding(`${m[3]}Provider`, impl, i + 1, "@riverpod");
  }
  const ann = annotations.match(INJECTABLE_ANN_RE);
  if (!ann && !/@(?:lazySingleton|singleton|injectable)\b/.test(annotations)) return null;
  let service = bareType(m[1]!);
  if (ann) {
    const open = ann.index! + ann[0].length - 1;
    const end = closeOf(annotations, open);
    const as = end < 0 ? undefined : readArgs(annotations.slice(open + 1, end - 1), annotations.slice(open + 1, end - 1)).named.get("as");
    if (as) service = bareType(as.code);
  }
  return binding(service, impl, i + 1, "@module", namedQualifier(annotations, rawAnnotationsAbove(lines, i), impl));
}

const CLASS_DECL_RE = /^\s*(?:@[\w.]+(?:\s*\([^)]*\))?\s*)*(?:(?:abstract|sealed|base|interface|final|mixin)\s+)*class\s+([A-Za-z_$]\w*)/;

const DI_WORDS_RE = /register|gh\b|Get\b|Provider|override/;

/** Every container registration in a Dart file → `FileAnalysis.diBindings`. */
export function extractDartDiBindings(lines: string[]): DiBinding[] {
  const out: DiBinding[] = [];
  const push = (b: DiBinding | null): void => {
    if (b) out.push(b);
  };
  const text = lines.join("\n");
  const injectable = /@(?:LazySingleton|Singleton|Injectable|lazySingleton|singleton|injectable)\b/.test(text);
  const generators = /@(?:module|riverpod|Riverpod)\b/.test(text);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // Cheap gate: every form below names one of these on its first line.
    if (!DI_WORDS_RE.test(raw) && !((injectable || generators) && (raw.includes("class") || raw.includes("=>")))) continue;
    if (raw.trimStart().startsWith("//")) continue;
    const code = codeOf(raw);
    if (code.includes("register")) {
      for (const m of code.matchAll(REGISTER_RE)) push(locatorRegistration(lines, i, m.index! + m[0].indexOf(m[1]!), m[1]!));
    }
    if (code.includes("gh")) {
      for (const m of code.matchAll(GH_RE)) push(locatorRegistration(lines, i, m.index! + m[0].indexOf(m[1]!), `gh.${m[1]}`));
    }
    if (code.includes("Get")) {
      for (const m of code.matchAll(GETX_RE)) push(locatorRegistration(lines, i, m.index! + m[0].indexOf(m[1]!), `Get.${m[1]}`));
    }
    if (code.includes("Provider")) {
      const riverpod = riverpodProvider(lines, i);
      if (riverpod) push(riverpod);
      else for (const m of code.matchAll(PROVIDER_WIDGET_RE)) push(providerWidget(lines, i, m.index!, m[1]!));
    }
    if (code.includes("override")) riverpodOverrides(lines, i, out);
    if (injectable) {
      const cls = code.match(CLASS_DECL_RE);
      if (cls) push(injectableClass(lines, i, cls[1]!));
    }
    if ((injectable || generators) && code.includes("=>") && !CLASS_DECL_RE.test(code)) push(annotatedFactory(lines, i));
  }
  return out;
}

// ─── Lookups ───────────────────────────────────────────────────────────────

/** Receivers a get_it / kiwi / GetX / Modular lookup is made on. */
const LOCATOR = String.raw`GetIt\s*\.\s*(?:I|instance)|_?(?:getIt|getit|sl|locator|serviceLocator|injector|ioc|di)|KiwiContainer\s*\(\s*\)|_?container|Get|Modular`;

/** A type argument as written. */
const TYPE_ARG = String.raw`[A-Za-z_$][\w$.]*(?:${GENERIC})?\??`;

/** The key a lookup's arguments name: `instanceName:` (get_it), `tag:` (GetX), a positional string (kiwi). */
function lookupKey(rawArgs: string): string | undefined {
  const args = readArgs(codeOf(rawArgs), rawArgs);
  const named = args.named.get("instanceName") ?? args.named.get("tag") ?? args.named.get("name");
  if (named) return keyValue(named.raw);
  const str = args.positional.find((a) => /^\s*r?(['"])/.test(a.raw));
  return str ? keyValue(str.raw) : undefined;
}

const LOCATOR_LOOKUP_RE = new RegExp(String.raw`^(?:${LOCATOR})\s*(?:\.\s*(?:get|call|getAsync|find|resolve)\s*)?<\s*(${TYPE_ARG})\s*>\s*\(([^()]*)\)$`);
const CONTEXT_LOOKUP_RE = new RegExp(String.raw`^[A-Za-z_$]\w*\s*\.\s*(?:read|watch)\s*<\s*(${TYPE_ARG})\s*>\s*\(\s*\)$`);
const PROVIDER_OF_RE = new RegExp(String.raw`^Provider\s*\.\s*of\s*<\s*(${TYPE_ARG})\s*>\s*\([^()]*\)$`);
const GETX_PUT_RE = new RegExp(String.raw`^Get\s*\.\s*put\s*<\s*(${TYPE_ARG})\s*>\s*\(`);
const RIVERPOD_READ_RE = /^[A-Za-z_$][\w$.]*\s*\.\s*(?:read|watch)\s*\(\s*([A-Za-z_$]\w*)\s*\)$/;

/**
 * What an initializer evaluates to, when the source states it: a locator
 * lookup (`getIt<UserRepo>()`, `GetIt.I.get<UserRepo>(instanceName: 'x')`,
 * `context.read<UserRepo>()`, `Provider.of<UserRepo>(context)`,
 * `Get.find<UserRepo>()`), a Riverpod read (`ref.read(repoProvider)` —
 * keyed by the provider; its type is filled in when the provider is declared
 * in the same file), a cast, or a construction.
 */
export function dartInitializerType(rhs: string): { type: string; qualifier?: string } | null {
  const text = rhs.replace(/;\s*$/, "").replace(/^\s*await\s+/, "").replace(/!\s*$/, "").trim();
  const locator = text.match(LOCATOR_LOOKUP_RE);
  if (locator) {
    const out: { type: string; qualifier?: string } = { type: locator[1]! };
    const key = lookupKey(locator[2]!);
    if (key) out.qualifier = key;
    return out;
  }
  const context = text.match(CONTEXT_LOOKUP_RE) ?? text.match(PROVIDER_OF_RE) ?? text.match(GETX_PUT_RE);
  if (context) return { type: context[1]! };
  const riverpod = text.match(RIVERPOD_READ_RE);
  if (riverpod) return { type: "", qualifier: riverpod[1]! };
  const cast = text.match(new RegExp(String.raw`\bas\s+(${TYPE_ARG})$`));
  if (cast) return { type: cast[1]! };
  const built = constructionOf(text);
  return built ? { type: built.type } : null;
}

/** The key a typed declaration's own initializer adds: `final UserRepo r = getIt<UserRepo>(instanceName: 'x');`. */
export function dartInitializerQualifier(rhs: string): string | undefined {
  const t = dartInitializerType(rhs);
  return t?.qualifier;
}

/** Statement words that can start a line shaped like `Type name …;`. */
const LOCAL_KEYWORDS =
  "return|await|yield|throw|rethrow|break|continue|assert|else|case|default|if|for|while|switch|do|try|catch|on|finally|new|const|final|late|var|in|is|as|print";

/**
 * The statements of one body line, raw and without its trailing comment:
 * split at top-level `;`, a one-line body's own braces dropped —
 * `{ val r = new PgRepo(); r.find(1) }` holds two.
 */
function statementsOf(line: string): string[] {
  const cut = blankStringLiterals(line).indexOf("//");
  let src = cut < 0 ? line : line.slice(0, cut);
  const open = src.match(/^\s*\{/);
  if (open) {
    src = " ".repeat(open[0].length) + src.slice(open[0].length);
    const close = src.lastIndexOf("}");
    if (close >= 0 && src.slice(close + 1).trim() === "") src = src.slice(0, close);
  }
  const code = blankStringLiterals(src);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    if (i === code.length || (c === ";" && depth === 0)) {
      const part = src.slice(start, i + (c === ";" ? 1 : 0));
      if (part.trim()) out.push(part);
      start = i + 1;
    }
  }
  return out;
}

/** A declaration that ends on its own line (with its `;`) — a wrapped chain's first line states no type. */
const UNTYPED_LOCAL_RE = /^\s*(?:(?:final|var|late|const)\s+)+([A-Za-z_$]\w*)\s*=\s*(.+?)\s*;\s*$/;
const TYPED_LOCAL_RE = new RegExp(
  String.raw`^\s*(?:(?:final|late|const)\s+)*(?!(?:${LOCAL_KEYWORDS})\b)(${TYPE_ARG})\s+(?!(?:${LOCAL_KEYWORDS})\b)([A-Za-z_$]\w*)\s*(?:=\s*(.+?))?\s*;\s*$`,
);

type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];

/** One entry per name; a name declared again with a different type, key or initializer is dropped. */
export function uniqueLocals(entries: NonNullable<FunctionInfo["localTypes"]>): NonNullable<FunctionInfo["localTypes"]> {
  const byName = new Map<string, LocalType | null>();
  for (const e of entries) {
    const prev = byName.get(e.name);
    if (prev === undefined) byName.set(e.name, e);
    else if (prev && (prev.type !== e.type || prev.qualifier !== e.qualifier || prev.from !== e.from)) byName.set(e.name, null);
  }
  return [...byName.values()].filter((e): e is LocalType => e !== null);
}

/**
 * `Club.fromJson(json)`, `league.Club.fromJson(json)` (an import prefix in
 * front), `await Club.load()`: a class-level call whose type the class states
 * — a named constructor's own class, a static method's declared return type —
 * as the `from` chain core types it by. Null for anything else.
 */
function classLevelCall(rhs: string): { from: string; awaited?: boolean } | null {
  const text = rhs.replace(/;\s*$/, "").replace(/!\s*$/, "").trim();
  const awaited = /^await\s+/.test(text);
  const body = text.replace(/^await\s+/, "").replace(/^(?:new|const)\s+/, "");
  const m = /^(?:[a-z_]\w*\s*\.\s*)?([A-Z]\w*)\s*(?:<[^()]*>)?\s*\.\s*([a-z_$]\w*)\s*\(/.exec(body);
  if (!m || closeOf(body, m[0].length - 1) !== body.length) return null;
  return { from: `${m[1]}.${m[2]}()`, ...(awaited ? { awaited: true } : {}) };
}

/** `List<Club>`, `Iterable<Club>?`, `Set<Club>`: the element class; null for anything else. */
function elementType(type: string | null | undefined): string | null {
  return /^\s*(?:List|Iterable|Set|Queue|UnmodifiableListView)\s*<\s*([A-Z]\w*)\s*>\s*\??\s*$/.exec(type ?? "")?.[1] ?? null;
}

/** Calls on a collection that hand each element (and nothing else) to their callback, and those that keep the collection's element type. */
const ELEMENT_CALLBACKS = new Set(["forEach", "map", "where", "any", "every", "firstWhere", "lastWhere", "singleWhere", "expand", "takeWhile", "skipWhile", "sort", "reduce", "indexWhere", "removeWhere", "retainWhere"]);
const KEEPS_ELEMENTS = new Set(["where", "toList", "toSet", "skip", "take", "skipWhile", "takeWhile", "sublist", "reversed", "whereNot"]);

/**
 * The parameters of closures a typed collection hands its elements to —
 * `clubs.forEach((c) => c.kickOff())`, `clubs.where(…).map((d) { … })`,
 * `for (final c in clubs)` — typed as the collection's element.
 */
function elementParams(body: string, collections: ReadonlyMap<string, string>): LocalType[] {
  const out: LocalType[] = [];
  for (const [name, element] of collections) {
    const re = new RegExp(String.raw`(?<![\w$.])(?:this\.)?${escapeRegex(name)}\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      let at = m.index + m[0].length;
      for (let hop = 0; hop < 6; hop++) {
        const seg = /^\s*[?!]?\.\s*([a-zA-Z_]\w*)\s*(?:<[^()<>]*>)?\s*(\()?/.exec(body.slice(at));
        if (!seg) break;
        const method = seg[1]!;
        if (!seg[2]) {
          if (method === "reversed") { at += seg[0].length; continue; }
          break;
        }
        const open = at + seg[0].length - 1;
        if (ELEMENT_CALLBACKS.has(method)) {
          const lambda = /^\(\s*\(\s*(?:final\s+)?(?:[A-Z]\w*\??\s+)?([a-z_$]\w*)(?:\s*,\s*(?:final\s+)?(?:[A-Z]\w*\??\s+)?([a-z_$]\w*))?\s*\)\s*(?:async\s*)?(?:=>|\{)/.exec(body.slice(open));
          if (lambda) {
            out.push({ name: lambda[1]!, type: element });
            // `sort((a, b) …)` / `reduce((a, b) …)` hand two elements.
            if (lambda[2] && (method === "sort" || method === "reduce")) out.push({ name: lambda[2], type: element });
          }
        }
        if (!KEEPS_ELEMENTS.has(method)) break;
        const close = closeOf(body, open);
        if (close < 0) break;
        at = close;
      }
    }
    for (const f of body.matchAll(new RegExp(String.raw`\bfor\s*\(\s*(?:final|var)\s+(?:[A-Z]\w*\??\s+)?([a-z_$]\w*)\s+in\s+(?:this\.)?${escapeRegex(name)}\s*\)`, "g"))) {
      out.push({ name: f[1]!, type: element });
    }
  }
  return out;
}

/**
 * Locals whose type the body states — `final UserRepo r = …;`, `UserRepo b =
 * PgRepo();`, `final a = ConcRepo();`, `final r = getIt<UserRepo>();`,
 * `final r = ref.read(repoProvider);` → `FunctionInfo.localTypes`.
 */
export function extractDartLocalTypes(bodyLines: string[], fn: { name: string; params?: readonly { name: string; type: string | null }[] }): NonNullable<FunctionInfo["localTypes"]> {
  const out: NonNullable<FunctionInfo["localTypes"]> = [];
  // Collections whose element type is stated: parameters and typed locals.
  const collections = new Map<string, string>();
  for (const p of fn.params ?? []) {
    const element = elementType(p.type);
    if (element) collections.set(p.name.replace(/^this\./, ""), element);
  }
  // Every declaration this reads either initialises (`=`) or ends `Type name;`.
  for (const line of bodyLines.flatMap((l) => (l.includes("=") || /^\s*[A-Za-z_$][\w$<>?, .]*\s+[A-Za-z_$]\w*\s*;/.test(l) ? statementsOf(l) : []))) {
    const untyped = line.match(UNTYPED_LOCAL_RE);
    if (untyped) {
      const t = dartInitializerType(untyped[2]!);
      if (t) out.push({ name: untyped[1]!, ...t });
      else {
        const call = classLevelCall(untyped[2]!);
        if (call) out.push({ name: untyped[1]!, type: "", ...call });
      }
      continue;
    }
    const typed = line.match(TYPED_LOCAL_RE);
    if (typed) {
      const entry: { name: string; type: string; qualifier?: string } = { name: typed[2]!, type: typed[1]! };
      const q = typed[3] ? dartInitializerQualifier(typed[3]) : undefined;
      if (q) entry.qualifier = q;
      out.push(entry);
      const element = elementType(typed[1]);
      if (element) collections.set(typed[2]!, element);
    }
  }
  if (collections.size > 0) {
    const body = bodyLines.map(codeOf).join("\n");
    out.push(...elementParams(body, collections));
  }
  return uniqueLocals(out);
}

// ─── Riverpod provider types ───────────────────────────────────────────────

/**
 * The object type each Riverpod provider declared in this file creates:
 * `final repoProvider = Provider<UserRepo>(…)` → repoProvider: UserRepo,
 * `@riverpod UserRepo userRepo(Ref ref) => …` → userRepoProvider: UserRepo.
 */
export function riverpodProviderTypes(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const generated = lines.some((l) => /@(?:riverpod|Riverpod)\b/.test(l));
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.includes("Provider") && !(generated && raw.includes("Ref"))) continue;
    const code = codeOf(raw);
    const decl = code.match(RIVERPOD_DECL_RE);
    if (decl) {
      const at = decl.index! + decl[0].length;
      const rest = code.slice(at).trimStart();
      if (rest.startsWith("<")) {
        const close = closeAngle(rest, 0);
        const first = close > 0 ? typeArgs(rest.slice(1, close - 1))[0] : undefined;
        if (first) out.set(decl[1]!, first);
      }
      continue;
    }
    if (!generated || !/@(?:riverpod|Riverpod)\b/.test(annotationsAbove(lines, i))) continue;
    const fn = code.match(new RegExp(String.raw`^\s*(${TYPE_ARG})\s+([A-Za-z_$]\w*)\s*\(\s*\w*Ref\b`));
    if (fn && !/^(?:Future|FutureOr|Stream)\b/.test(fn[1]!)) out.set(`${fn[2]}Provider`, fn[1]!);
  }
  return out;
}

/** Give Riverpod reads keyed by a provider of this file the provider's declared type. */
export function applyProviderTypes(fns: FunctionInfo[], providers: Map<string, string>): void {
  if (providers.size === 0) return;
  for (const fn of fns) {
    for (const l of fn.localTypes ?? []) {
      if (!l.type && l.qualifier && providers.has(l.qualifier)) l.type = providers.get(l.qualifier)!;
    }
    for (const c of fn.calls as CallInfo[]) {
      if (!c.receiverType && c.receiverQualifier && providers.has(c.receiverQualifier)) c.receiverType = providers.get(c.receiverQualifier)!;
    }
  }
}

// ─── Lookups chained into a call; generic calls ────────────────────────────

const strip = (s: string): string => s.replace(/\s+/g, "");

/**
 * `getIt<UserRepo>().find(…)`, `GetIt.I.get<UserRepo>(instanceName: 'mem')
 * .load()`, `context.read<UserRepo>().save()`, `Provider.of<UserRepo>(ctx)
 * .find()`, `ref.read(repoProvider).save()` — the receiver is what the lookup
 * names — and plain generic calls (`context.read<UserRepo>()`), which the
 * baseline `name(` matcher cannot see past their type arguments.
 */
export const dartDiCallPatterns: CallPattern[] = [
  {
    // A call through a field path (`player.kit.wash()`, `this.squad.coach.brief()`):
    // the whole chain, so the receiver is typed field by field, not by its last name.
    pattern: /(?<![\w$.)\]])((?:this\s*\.\s*)?[a-z_$][\w$]*(?:\s*[?!]?\.\s*[a-z_$][\w$]*){2,})\s*\(/,
    buildName: (m) => {
      const name = m[1]!.replace(/\s+/g, "").replace(/[?!]\./g, ".");
      return { name, leafName: name.split(".").pop()! };
    },
  },
  {
    pattern: new RegExp(String.raw`\b(${LOCATOR})\s*(?:\.\s*(get|call|find|resolve)\s*)?<\s*(${TYPE_ARG})\s*>\s*\(([^()]*)\)\s*[!?]?\s*\.\s*([A-Za-z_$]\w*)\s*\(`),
    buildName: (m, rawLine) => {
      const name = `${strip(m[1]!)}${m[2] ? "." + m[2] : ""}<${strip(m[3]!)}>().${m[5]}`;
      const argsAt = m.index + m[0].indexOf("(", m[0].indexOf(">"));
      const rawArgs = rawLine?.slice(argsAt + 1, argsAt + 1 + m[4]!.length) ?? "";
      const key = m[4]!.trim() ? lookupKey(rawArgs) : undefined;
      return key ? { name, leafName: m[5]!, receiverType: m[3]!, receiverQualifier: key } : { name, leafName: m[5]!, receiverType: m[3]! };
    },
  },
  {
    pattern: new RegExp(String.raw`\b([A-Za-z_$]\w*)\s*\.\s*(read|watch)\s*<\s*(${TYPE_ARG})\s*>\s*\(\s*\)\s*[!?]?\s*\.\s*([A-Za-z_$]\w*)\s*\(`),
    buildName: (m) => ({ name: `${m[1]}.${m[2]}<${strip(m[3]!)}>().${m[4]}`, leafName: m[4]!, receiverType: m[3]! }),
  },
  {
    pattern: new RegExp(String.raw`\bProvider\s*\.\s*of\s*<\s*(${TYPE_ARG})\s*>\s*\([^()]*\)\s*[!?]?\s*\.\s*([A-Za-z_$]\w*)\s*\(`),
    buildName: (m) => ({ name: `Provider.of<${strip(m[1]!)}>().${m[2]}`, leafName: m[2]!, receiverType: m[1]! }),
  },
  {
    // `ref.read(repoProvider).save()`, and a notifier's method through `ref.read(xProvider.notifier).start()`:
    // the provider is the token either way (its binding is the object its factory builds).
    pattern: /\b([A-Za-z_$][\w$]*)\s*\.\s*(read|watch)\s*\(\s*([A-Za-z_$]\w*)(\s*\.\s*notifier)?\s*\)\s*[!?]?\s*\.\s*([A-Za-z_$]\w*)\s*\(/,
    buildName: (m) => ({ name: `${m[1]}.${m[2]}(${m[3]}${m[4] ? ".notifier" : ""}).${m[5]}`, leafName: m[5]!, receiverQualifier: m[3]! }),
  },
  {
    // A plain generic call. The type list admits only type characters, so a
    // comparison (`i<n && x>(y)`) is never read as one.
    pattern: /\b([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)<([\w$.?<>, ]+)>\s*\(/,
    buildName: (m) => {
      const recv = strip(m[1]!);
      return { name: `${recv}<${strip(m[2]!)}>`, leafName: recv.split(".").pop()! };
    },
  },
];
