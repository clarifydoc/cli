import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** A CPAN distribution: `prove -lr t` for its `t/` tests (Makefile.PL, Build.PL or a cpanfile states the distribution); a Dist::Zilla one is built by `dzil`. */
export function perlProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const source = ["Makefile.PL", "Build.PL", "dist.ini", "cpanfile"].find((f) => root.exists(f));
  if (!source) return [];
  if (source === "dist.ini") return [{ kind: "test", command: "dzil test", source }];
  return root.exists("t") ? [{ kind: "test", command: "prove -lr t", source }] : [];
}
