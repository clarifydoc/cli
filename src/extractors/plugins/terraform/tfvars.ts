import type { ConfigEntry, ServiceConfigSpec } from "../../../types/language-plugin.js";

/**
 * Terraform variable files (`terraform.tfvars`, `prod.auto.tfvars`, `prod.tfvars`): each top-level
 * `name = value` sets the `variable "name"` block of the module beside it. Names only — the value is
 * never read (these files hold credentials as often as sizes). Leaf module.
 */
export function tfvarsKeys(text: string, path: string): ConfigEntry[] {
  // A downloaded module's own example variables are not this project's settings.
  if (/(?:^|\/)\.terraform\//.test(path)) return [];
  const out: ConfigEntry[] = [];
  let depth = 0;
  let line = 0;
  let heredoc: string | null = null;
  for (const raw of text.split("\n")) {
    line++;
    if (heredoc !== null) {
      if (raw.trim() === heredoc) heredoc = null;
      continue;
    }
    // Code outside string literals, up to a comment.
    let code = "";
    let quoted = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (quoted) {
        if (ch === "\\") i++;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === "#" || (ch === "/" && raw[i + 1] === "/")) break;
      else code += ch;
    }
    if (depth === 0) {
      const m = /^([A-Za-z_][\w-]*)\s*=/.exec(code);
      if (m) out.push({ key: m[1]!, value: "", line });
    }
    heredoc = /<<-?\s*([A-Za-z_]\w*)\s*$/.exec(code)?.[1] ?? null;
    for (const ch of code) {
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if (ch === "}" || ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    }
  }
  return out;
}

export const terraformServiceConfig: ServiceConfigSpec = {
  sources: [{ files: ["**/*.tfvars"], glob: { deep: 8, limit: 200 }, keysOnly: true, parse: tfvarsKeys }],
};
