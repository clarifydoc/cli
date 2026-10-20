import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** package.json scripts, run through the package manager the lockfile names. */
export function jsProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const text = root.read("package.json");
  if (!text) return [];
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = pkg.scripts ?? {};
  const runner = root.entries.includes("pnpm-lock.yaml") ? "pnpm" : root.entries.includes("yarn.lock") ? "yarn" : root.entries.includes("bun.lockb") || root.entries.includes("bun.lock") ? "bun" : "npm";
  const run = (script: string) => (runner === "npm" ? (script === "test" || script === "start" ? `npm ${script}` : `npm run ${script}`) : `${runner} ${script}`);
  const out: ProjectCommand[] = [];
  for (const [kind, names] of [["build", ["build"]], ["test", ["test"]], ["start", ["start", "serve"]], ["dev", ["dev"]], ["lint", ["lint"]]] as const) {
    const name = names.find((n) => typeof scripts[n] === "string" && !/no test specified/.test(String(scripts[n])));
    if (name) out.push({ kind, command: run(name), source: `package.json scripts.${name}` });
  }
  return out;
}
