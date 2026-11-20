import { posix } from "path";
import type { FileAnalysis, SubComponentInfo } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { buildFilePathMap, resolveTarget } from "../../shared/link-scoring.js";

/**
 * A tag written through a namespace import — `<UI.ConfirmDialog onConfirm={save} />` after
 * `import * as UI from "./ui"` — names a member of that module, not the module. The extractor states the module and
 * the member (`SubComponentInfo.namespaceMember`); the file the member lives in is found here, through the module's own
 * exports and the re-exports a barrel forwards (`export { ConfirmDialog } from "./ConfirmDialog"`, `export *` when
 * exactly one file defines it) — never by the member's name alone. A member that no export of the module reaches
 * leaves the tag unresolved.
 */
const MAX_HOPS = 4;

/** The file an import or re-export specifier written in `fromFile` names. */
function target(source: string, fromFile: string, map: Map<string, string>): string | undefined {
  return resolveTarget(source, fromFile, map)?.split("\u0000")[0];
}

/** What `follow` finds through the module's `export *` sources — only when exactly one file answers. */
function uniqueStarHit(owner: FileAnalysis, map: Map<string, string>, follow: (next: string) => string | null): string | null {
  const found = new Set<string>();
  for (const e of owner.exports) {
    if (e.kind !== "re-export" || !e.source || e.name !== "*") continue;
    const next = target(e.source, owner.filePath, map);
    const hit = next ? follow(next) : null;
    if (hit) found.add(hit);
  }
  return found.size === 1 ? [...found][0]! : null;
}

function memberFile(file: string, member: string, byPath: Map<string, FileAnalysis>, map: Map<string, string>, hop: number): string | null {
  const owner = byPath.get(file);
  if (!owner || hop > MAX_HOPS) return null;
  if (owner.exports.some((e) => e.name === member && !(e.kind === "re-export" && e.source))) return file;
  const e = owner.exports.find((x) => x.kind === "re-export" && x.source && x.name === member);
  if (e) {
    const next = target(e.source!, owner.filePath, map);
    if (!next) return null;
    const hit = memberFile(next, e.sourceName ?? member, byPath, map, hop + 1);
    if (hit || e.sourceName !== "default") return hit;
    // `export { default as ConfirmDialog } from "./ConfirmDialog.vue"`: a component file that states no export names
    // itself the default (an SFC), unless it forwards a default of its own, which the walk above followed.
    const forwarded = byPath.get(next);
    return forwarded && /\.(?:vue|svelte)$/.test(next) && !forwarded.exports.some((x) => x.name === "default") ? next : null;
  }
  // `export *` never forwards a default.
  if (member === "default") return null;
  return uniqueStarHit(owner, map, (next) => memberFile(next, member, byPath, map, hop + 1));
}

/**
 * The file a module's export `name` stands for as a whole namespace: `export * as Forms from "./forms"`, followed
 * through a forwarding rename (`export { Forms } from "./kit"`) and through `export *` when exactly one file has it.
 */
function moduleOf(file: string, name: string, byPath: Map<string, FileAnalysis>, map: Map<string, string>, hop: number): string | null {
  const owner = byPath.get(file);
  if (!owner || hop > MAX_HOPS) return null;
  const e = owner.exports.find((x) => x.kind === "re-export" && x.source && x.name === name);
  if (e) {
    const next = target(e.source!, owner.filePath, map);
    if (!next) return null;
    return e.sourceName === "*" ? next : moduleOf(next, e.sourceName ?? name, byPath, map, hop + 1);
  }
  return uniqueStarHit(owner, map, (next) => moduleOf(next, name, byPath, map, hop + 1));
}

/** The file a namespaced tag's member lives in: the head's module, each namespace segment followed, then the member. */
function namespacedFile(from: FileAnalysis, tag: NonNullable<SubComponentInfo["namespaceMember"]>, byPath: Map<string, FileAnalysis>, map: Map<string, string>): string | null {
  let module: string | null | undefined = target(tag.source, from.filePath, map);
  if (module && tag.through) module = moduleOf(module, tag.through, byPath, map, 0);
  const segments = tag.member.split(".");
  const last = segments.pop()!;
  for (const segment of segments) {
    if (!module) return null;
    module = moduleOf(module, segment, byPath, map, 0);
  }
  return module ? memberFile(module, last, byPath, map, 0) : null;
}

/** The specifier of `file` as written in `from` (extension of a script file dropped). */
function specifierFor(from: string, file: string): string {
  const rel = posix.relative(posix.dirname(from), file).replace(/\.(?:[mc]?[jt]sx?)$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * The analyses with each namespaced tag's `importSource` set to the file its member lives in, so every resolver reads
 * it as an ordinary import. A copy: the input is never changed, and the same array comes back when no file has such a tag.
 */
export function withNamespaceTags(analyses: FileAnalysis[]): FileAnalysis[] {
  const hit = VIEWS.get(analyses);
  if (hit) return hit;
  const view = resolveViews(analyses);
  VIEWS.set(analyses, view);
  return view;
}

/** One view per analyses array: every resolver of a run asks. */
const VIEWS = new WeakMap<FileAnalysis[], FileAnalysis[]>();

/**
 * The import that binds a tag's local name and the name it asks of the module (`default` for a default import) — only
 * a static named or default import, never a namespace or a dynamic one.
 */
function importedName(a: FileAnalysis, local: string, source: string): string | null {
  for (const imp of a.imports) {
    if (imp.source !== source || imp.isNamespace || imp.dynamic || imp.isType || !imp.specifiers.includes(local)) continue;
    // `import Foo, { Bar }`: the default binding is the first specifier.
    return imp.aliases?.[local] ?? (imp.isDefault && imp.specifiers[0] === local ? "default" : local);
  }
  return null;
}

function resolveViews(analyses: FileAnalysis[]): FileAnalysis[] {
  const barrels = analyses.some((a) => a.exports.some((e) => e.kind === "re-export" && e.source));
  const needs = (a: FileAnalysis) => a.subComponents?.some((s) => (s.namespaceMember && !s.importSource) || (barrels && s.importSource && !s.namespaceMember));
  if (!analyses.some(needs)) return analyses;
  const map = buildFilePathMap(analyses);
  const byPath = new Map(analyses.map((a) => [a.filePath, a]));
  return analyses.map((a) => {
    if (!needs(a)) return a;
    const subComponents = a.subComponents!.map((s): SubComponentInfo => {
      // A plain import: when it names a barrel, the file its export walk reaches for the name asked.
      if (s.importSource && !s.namespaceMember) {
        const name = importedName(a, s.name, s.importSource);
        const module = name ? target(s.importSource, a.filePath, map) : null;
        if (!name || !module || module === a.filePath) return s;
        const file = memberFile(module, name, byPath, map, 0);
        return file && file !== module && file !== a.filePath ? { ...s, importSource: specifierFor(a.filePath, file) } : s;
      }
      if (!s.namespaceMember || s.importSource) return s;
      const file = namespacedFile(a, s.namespaceMember, byPath, map);
      return file && file !== a.filePath ? { ...s, importSource: specifierFor(a.filePath, file) } : s;
    });
    return { ...a, subComponents };
  });
}

/** A resolver that reads the analyses with their namespaced tags resolved. */
export function seeingNamespaceTags<R extends DispatchResolver>(resolver: R): R {
  const wrapped = Object.create(resolver) as R;
  wrapped.resolve = (analyses: FileAnalysis[]) => resolver.resolve(withNamespaceTags(analyses));
  return wrapped;
}
