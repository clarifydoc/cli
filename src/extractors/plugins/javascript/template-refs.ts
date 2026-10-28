import type { FileAnalysis, Language, SubComponentInfo, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { isComponentTag } from "../../../parsers/template-tree.js";
import { buildFilePathMap, resolveTarget } from "../../shared/link-scoring.js";
import { autoImportedComponents, globalComponentFiles, tagKey } from "./dispatch.js";

/** An opening tag of the template, with its attributes. */
const OPEN_TAG = /<([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>'"])*)>/g;
/** A static `ref="formRef"` — never a bound `:ref`. */
const STATIC_REF = /(?:^|\s)ref\s*=\s*(?:"\s*([A-Za-z_$][\w$]*)\s*"|'\s*([A-Za-z_$][\w$]*)\s*')/;
/** `const form = useTemplateRef('formRef')`: a variable that holds the instance `ref="formRef"` names. */
const USE_TEMPLATE_REF = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*useTemplateRef\s*(?:<[^>]*>)?\s*\(\s*['"]([\w$-]+)['"]/g;

/**
 * Each component tag of a Vue template that carries a static `ref`, by tag key
 * → the names the file reaches that instance by (the ref, and every
 * `useTemplateRef` variable of the script bound to it). Set on the file's
 * `subComponents` as `refs`.
 */
export function addTemplateRefs(subComponents: SubComponentInfo[], template: string, script: string): void {
  const aliases = new Map<string, string[]>();
  for (const m of script.matchAll(USE_TEMPLATE_REF)) aliases.set(m[2]!, [...(aliases.get(m[2]!) ?? []), m[1]!]);
  const byKey = new Map(subComponents.map((s) => [tagKey(s.name), s]));
  for (const m of template.matchAll(OPEN_TAG)) {
    if (!isComponentTag(m[1]!)) continue;
    const ref = STATIC_REF.exec(m[2]!);
    const name = ref?.[1] ?? ref?.[2];
    const sub = name ? byKey.get(tagKey(m[1]!)) : undefined;
    if (!sub || !name) continue;
    sub.refs = [...new Set([...(sub.refs ?? []), name, ...(aliases.get(name) ?? [])])];
  }
}

/**
 * The child and member a call through a template ref names: `formRef.value.save`,
 * `formRef.value?.save`, `this.$refs.formRef.save`, `$refs.formRef?.save`, and in
 * markup (where refs unwrap) `formRef.save`.
 */
export function templateRefCall(name: string, inMarkup: boolean): { ref: string; member: string } | null {
  const plain = name.replace(/\?\.(?=[\w$])/g, ".");
  const viaRefs = /^(?:this\.)?\$refs(?:\.([\w$]+)|\[\s*['"]([\w$-]+)['"]\s*\])\.([\w$]+)$/.exec(plain);
  if (viaRefs) return { ref: viaRefs[1] ?? viaRefs[2]!, member: viaRefs[3]! };
  // React's handle: `formRef.current.save()`, `this.formRef.current.save()`.
  const handle = /^((?:this\.)?[\w$]+)\.current\.([\w$]+)$/.exec(plain);
  if (handle) return { ref: handle[1]!, member: handle[2]! };
  const unwrapped = /^([\w$]+)\.value\.([\w$]+)$/.exec(plain) ?? (inMarkup ? /^([\w$]+)\.([\w$]+)$/.exec(plain) : null);
  if (unwrapped && unwrapped[2] !== "value") return { ref: unwrapped[1]!, member: unwrapped[2]! };
  return null;
}

/**
 * Template-ref dispatch: a parent calls a child component's method through the
 * instance its template binds (`<ClubForm ref="formRef">`, then
 * `formRef.value?.save()` or Options API `this.$refs.formRef.save()`). The call
 * names a local ref the linker cannot type, so `save` dead-ended in the parent;
 * the method it runs is the child's — a `<script setup>` function it exposes, or
 * an Options API method. React's is the same join: `<CarForm ref={formRef} />`,
 * `formRef.current.save()`, and the function the child's `useImperativeHandle`
 * hands out.
 *
 * The join is exact: the ref is bound on ONE child tag of the file (a name two
 * different children carry is left out), the tag resolves to the child's file
 * the way the emit resolver resolves it, and the child declares a function of
 * that name. One link per call site, callName as written.
 */
export class JsTemplateRefResolver implements DispatchResolver {
  readonly id = "template-ref";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 34;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const parents = analyses.filter((a) => a.subComponents?.some((s) => s.refs?.length));
    if (parents.length === 0) return [];
    const filePathMap = buildFilePathMap(analyses);
    const byPath = new Map(analyses.map((a) => [a.filePath, a]));
    const globals = globalComponentFiles(analyses, filePathMap);
    const autoImported = autoImportedComponents(analyses);
    const links: SymbolLink[] = [];
    for (const parent of parents) {
      const childOf = new Map<string, string | null>();
      for (const sub of parent.subComponents) {
        if (!sub.refs?.length) continue;
        const source = sub.importSource && !sub.global ? sub.importSource : null;
        const file = source ? resolveTarget(source, parent.filePath, filePathMap) : globals.get(tagKey(sub.name)) ?? autoImported.get(parent.projectId ?? "")?.get(tagKey(sub.name)) ?? null;
        if (!file || !byPath.has(file)) continue;
        for (const ref of sub.refs) childOf.set(ref, childOf.has(ref) && childOf.get(ref) !== file ? null : file);
      }
      const fns = [...parent.functions, ...parent.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
      for (const fn of fns) {
        for (const call of fn.calls ?? []) {
          // Markup is `<setup>` or a binding's own function (`<ClubHeader@edit@12>`); only there does a ref unwrap.
          const hit = templateRefCall(call.name, fn.name.startsWith("<"));
          const childFile = hit ? childOf.get(hit.ref) : undefined;
          if (!hit || !childFile) continue;
          const target = memberOf(byPath.get(childFile)!, hit.member);
          if (!target) continue;
          links.push({
            sourceFile: parent.filePath,
            sourceSymbol: fn.name,
            sourceLine: call.line,
            callName: call.name,
            targetFile: childFile,
            targetSymbol: target.symbol,
            targetLine: target.line,
            confidence: "EXTRACTED",
          });
        }
      }
    }
    return links;
  }
}

/** The child's function of that name: a top-level or component-local one (`<script setup>`, Options API `methods`, a `forwardRef` body's), or a method of its one class. */
function memberOf(child: FileAnalysis, member: string): { symbol: string; line: number } | null {
  const fn = child.functions.find((f) => f.name === member);
  if (fn) return { symbol: fn.name, line: fn.line };
  if (child.classes.length !== 1) return null;
  const cls = child.classes[0]!;
  const m = cls.methods.find((x) => x.name === member);
  return m ? { symbol: `${cls.name}.${m.name}`, line: m.line } : null;
}
