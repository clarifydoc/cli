import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Erlang dead-code model. A module IS its file (`-module(x)` in `x.erl`) and
 * is used by name (`x:start()`, supervisor child specs); `-include("x.hrl")`
 * names a file. A program starts at the application callback module the
 * `.app.src` names (`{mod, {x_app, []}}`), an `application` behaviour, or an
 * escript's `main`.
 */
export const erlangReachability = conventionReachability({
  extensions: [".erl", ".hrl", ".escript"],
  importPath: (source) => (/\.hrl$/.test(source) ? source : null),
  names: { stem: true },
  entryFiles: [[/\.escript$/, "escript"]],
  entrySource: [
    [/-behaviou?r\(\s*application\s*\)/, "OTP application"],
    [/^\s*main\s*\(/m, "escript main"],
  ],
  async extend(_ctx, kit) {
    const mentions = new Set<string>();
    for (const rel of await kit.listFiles()) {
      if (!/\.app(?:\.src)?$/.test(rel)) continue;
      const text = (await kit.readText(rel)) ?? "";
      for (const m of text.matchAll(/\{\s*mod\s*,\s*\{\s*'?([a-z][\w@]*)/g)) mentions.add(m[1]!);
    }
    return mentions.size > 0 ? { configMentions: mentions } : {};
  },
});
