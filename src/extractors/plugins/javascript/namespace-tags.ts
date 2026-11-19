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

function memberFile(file: string, member: string, byPath: Map<string, FileAnalysis>, map: Map<string, string>, hop: number): string | null {
  const owner = byPath.get(file);
  if (!owner || hop > MAX_HOPS) return null;
  if (owner.exports.some((e) => e.name === member && !(e.kind === "re-export" && e.source))) return file;
  const named = owner.exports.filter((e) => e.kind === "re-export" && e.source && e.name === member);
  if (named.length > 0) {
    const e = named[0]!;
    const next = resolveTarget(e.source!, owner.filePath, map)?.split("\u0000")[0];
    return next ? memberFile(next, e.sourceName ?? member, byPath, map, hop + 1) : null;
  }
  const found = new Set<string>();
  for (const e of owner.exports) {
    if (e.kind !== "re-export" || !e.source || e.name !== "*") continue;
    const next = resolveTarget(e.source, owner.filePath, map)?.split("\u0000")[0];
    const hit = next ? memberFile(next, member, byPath, map, hop + 1) : null;
    if (hit) found.add(hit);
  }
  return found.size === 1 ? [...found][0]! : null;
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

function resolveViews(analyses: FileAnalysis[]): FileAnalysis[] {
  if (!analyses.some((a) => a.subComponents?.some((s) => s.namespaceMember && !s.importSource))) return analyses;
  const map = buildFilePathMap(analyses);
  const byPath = new Map(analyses.map((a) => [a.filePath, a]));
  return analyses.map((a) => {
    if (!a.subComponents?.some((s) => s.namespaceMember && !s.importSource)) return a;
    const subComponents = a.subComponents.map((s): SubComponentInfo => {
      if (!s.namespaceMember || s.importSource) return s;
      const module = resolveTarget(s.namespaceMember.source, a.filePath, map)?.split("\u0000")[0];
      const file = module ? memberFile(module, s.namespaceMember.member, byPath, map, 0) : null;
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
