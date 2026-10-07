import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** The text of the `.{ … }` that opens at `from` (the index of its `{`), braces matched. */
function block(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(from + 1, i);
  }
  return text.slice(from + 1);
}

/**
 * `build.zig.zon`: each entry of `.dependencies = .{ … }` —
 * `.zap = .{ .url = "https://…/v0.9.1.tar.gz", .hash = "…" }`,
 * `.@"zig-clap" = .{ … }`, `.pg = .{ .path = "../pg" }`. A tag in the URL is
 * the version; a commit or a path pins none.
 */
function parseZon(text: string, declaredIn: string): DeclaredPackage[] {
  // `//` comments, never the `//` of a URL inside a string.
  const clean = text.split("\n").map((line) => line.replace(/^((?:[^"/]|"(?:[^"\\]|\\.)*"|\/(?!\/))*)\/\/.*$/, "$1")).join("\n");
  const start = /\.dependencies\s*=\s*\.\{/.exec(clean);
  if (!start) return [];
  const deps = block(clean, start.index + start[0].length - 1);
  const out: DeclaredPackage[] = [];
  const entry = /\.(?:@"([^"]+)"|([A-Za-z_]\w*))\s*=\s*\.\{/g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(deps)) !== null) {
    const body = block(deps, m.index + m[0].length - 1);
    entry.lastIndex = m.index + m[0].length + body.length;
    const url = /\.url\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? "";
    const version = /(?:\/|#)v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+?)?)(?:\.tar\.gz|\.zip|$)/.exec(url)?.[1] ?? null;
    out.push(declared(m[1] ?? m[2]!, version, "zig", "prod", declaredIn));
  }
  return out;
}

export const zigPackageManager: PackageManagerSpec = {
  ecosystem: "zig",
  manifests: [{ files: ["build.zig.zon"], parse: (text, file) => parseZon(text, file.declaredIn) }],
  // `@import("zap")` — the module `build.zig` wires from the dependency; a
  // `.zig` path is a file, `std`/`builtin`/`root` are the compiler's.
  importKey: (s) => (/\.zig$/.test(s) || /^(?:std|builtin|root)$/.test(s) ? null : s.toLowerCase()),
};
