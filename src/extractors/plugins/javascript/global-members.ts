import type { GlobalMemberDef } from "../../../types/analysis.js";

/** `app.config.globalProperties.$session = $session` (Vue 3), `Vue.prototype.$api = api` (Vue 2). */
const GLOBAL_MEMBER_RE = /(?:\.config\.globalProperties|\bVue\.prototype)\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/gm;

/** The members a module installs on every component instance, each with the binding it assigns. */
export function extractGlobalMembers(sourceText: string): GlobalMemberDef[] {
  if (!sourceText.includes("globalProperties") && !sourceText.includes("Vue.prototype")) return [];
  const out: GlobalMemberDef[] = [];
  for (const m of sourceText.matchAll(GLOBAL_MEMBER_RE)) {
    out.push({ name: m[1]!, binding: m[2]!, line: sourceText.slice(0, m.index).split("\n").length });
  }
  return out;
}
