import type { StructuralMatch } from "../../../types/language-plugin.js";

/**
 * Go demands identical method signatures, and an unexported method can only be
 * satisfied from the interface's own package.
 */
export const goStructuralMatch: StructuralMatch = {
  typeKey(t, result) {
    // A result's pointer is not always kept by the extractor, so only a parameter's counts.
    let k = t?.replace(/\s+/g, "").replace(/\b[A-Za-z_]\w*\./g, "").replace(/interface\{\}/g, "any") ?? "";
    if (result) k = k.replace(/^\*/, "");
    return k === "" || /(^|[^\w])[A-Z]\d?(?!\w)/.test(k) ? null : k;
  },
  packagePrivate: (name) => /^[a-z_]/.test(name),
};
