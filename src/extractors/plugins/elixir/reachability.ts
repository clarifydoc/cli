import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Elixir dead-code model. Every module under `lib/` is compiled, and a module
 * is used through its NAME (`alias MyApp.Accounts.User`, `User.changeset`):
 * a module nothing mentions is dead. A program starts at the OTP application
 * `mix.exs` names (`mod: {MyApp.Application, []}`) or an escript's
 * `main_module` — `mix.exs` itself is only the project file, and a library
 * (a Hex package with no `mod:`) starts nothing and is not judged.
 */
export const elixirReachability = conventionReachability({
  extensions: [".ex", ".exs"],
  names: { types: true, stem: true, declaration: /\bdefmodule\s+([A-Z][\w.]*)/g },
  entryFiles: [[/^lib\/[^/]+\/application\.ex$/, "OTP application"]],
  entrySource: [[/\buse\s+Application\b/, "OTP application"]],
  passiveFiles: [
    [/(?:^|\/)mix\.exs$/, "Mix project file"],
    [/^config\//, "configuration (evaluated at boot)"],
    [/^priv\//, "migrations, seeds"],
    [/^lib\/mix\/tasks\//, "Mix task"],
    [/^rel\//, "release configuration"],
  ],
  async extend(_ctx, kit) {
    const mentions = new Set<string>();
    for (const root of kit.roots) {
      const text = (await kit.readText(root ? `${root}/mix.exs` : "mix.exs")) ?? "";
      for (const m of text.matchAll(/\b(?:mod:\s*\{\s*|main_module:\s*)([A-Z][\w.]*)/g)) mentions.add(m[1]!.split(".").pop()!);
    }
    return mentions.size > 0 ? { configMentions: mentions } : {};
  },
});
