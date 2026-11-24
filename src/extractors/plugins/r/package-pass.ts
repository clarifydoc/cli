import { posix } from "node:path";
import { readTextFile } from "../../../core/read-text-file.js";
import { insideRoot } from "../../../core/inside-root.js";
import type { CallInfo, FileAnalysis } from "../../../types/analysis.js";
import type { ProjectPass, ProjectPassContext } from "../../../types/language-plugin.js";

const REPLACEMENT = /^.+<-$/;
const INFIX = /^%.+%$/;

/** The calls a file's functions and class methods hold. */
function callLists(a: FileAnalysis): CallInfo[][] {
  return [...a.functions.map((f) => f.calls), ...a.classes.flatMap((c) => c.methods.map((m) => m.calls))];
}

/**
 * R calls that only the whole project can judge:
 *  - `pkg::f()` where `pkg` is the `Package:` of the DESCRIPTION above the file is a call into the package's own
 *    `R/` directory, joined to the ONE function of that name there (a namesake in another directory is no part of it);
 *  - a replacement call (`rank(xs) <- 2` → `rank<-`) or an infix operator (`a %+% b`) is kept only where the
 *    project defines that function or method — an operator or setter nothing declares is the language's or a package's.
 */
export const rPackagePass: ProjectPass = {
  label: "R package calls",
  async run(analyses: FileAnalysis[], ctx: ProjectPassContext): Promise<number> {
    const r = analyses.filter((a) => a.language === "r");
    if (r.length === 0) return 0;
    const definedIn = new Map<string, Set<string>>();
    const define = (name: string, file: string): void => {
      (definedIn.get(name) ?? definedIn.set(name, new Set()).get(name)!).add(file);
    };
    for (const a of r) {
      for (const f of a.functions) define(f.name, a.filePath);
      for (const c of a.classes) for (const m of c.methods) define(m.name, a.filePath);
    }

    let changed = 0;
    const packageOf = packageLookup(ctx);
    for (const a of r) {
      let own: { name: string; root: string } | null | undefined;
      for (const calls of callLists(a)) {
        for (let i = calls.length - 1; i >= 0; i--) {
          const call = calls[i]!;
          if ((REPLACEMENT.test(call.name) || INFIX.test(call.name)) && !definedIn.has(call.name)) {
            calls.splice(i, 1);
            changed++;
            continue;
          }
          // The one file of the project that defines the operator or setter is where the call goes.
          const opHomes = (REPLACEMENT.test(call.name) || INFIX.test(call.name)) && call.kind === "internal" ? definedIn.get(call.name) : undefined;
          if (opHomes && opHomes.size === 1) {
            const [home] = opHomes;
            if (home !== a.filePath) { call.kind = "cross-file"; call.target = home!; call.confidence = "INFERRED"; changed++; }
            continue;
          }
          if (!call.name.includes(".")) continue;
          if (own === undefined) own = await packageOf(a.filePath);
          if (!own || !call.name.startsWith(`${own.name}.`)) continue;
          const bare = call.name.slice(own.name.length + 1);
          const prefix = own.root ? `${own.root}/R/` : "R/";
          const homes = [...(definedIn.get(bare) ?? [])].filter((f) => f.startsWith(prefix));
          if (homes.length !== 1) continue;
          call.name = bare;
          call.kind = "cross-file";
          call.target = homes[0]!;
          changed++;
        }
      }
    }
    return changed;
  },
};

/** The `Package:` of the nearest DESCRIPTION at or above a file's directory (null when none names one), read once per directory. */
function packageLookup(ctx: ProjectPassContext): (file: string) => Promise<{ name: string; root: string } | null> {
  const byDir = new Map<string, Promise<{ name: string; root: string } | null>>();
  const read = (dir: string): Promise<{ name: string; root: string } | null> => {
    let hit = byDir.get(dir);
    if (!hit) {
      hit = (async () => {
        const path = insideRoot(ctx.projectRoot, posix.join(dir, "DESCRIPTION"));
        const text = path ? await readTextFile(path).catch(() => null) : null;
        const name = text ? /^Package:\s*([A-Za-z][\w.]*)\s*$/m.exec(text)?.[1] : undefined;
        if (name) return { name, root: dir };
        return dir ? read(posix.dirname(dir) === "." ? "" : posix.dirname(dir)) : null;
      })();
      byDir.set(dir, hit);
    }
    return hit;
  };
  return (file) => read(posix.dirname(file) === "." ? "" : posix.dirname(file));
}
