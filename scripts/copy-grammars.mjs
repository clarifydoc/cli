// tsdown onSuccess hook: copies every tree-sitter grammar the plugins load into
// dist/grammars/, beside its package's licence, so the published package carries
// its parsers and installs with no grammar package at all. Grammar packages are
// devDependencies: npm would otherwise compile their native bindings on every
// install (which the analyzer never loads — it parses through web-tree-sitter),
// and the three pinned to upstream commits would need git and a compiler.
// parser-manager.ts reads dist/grammars/ first and falls back to node_modules,
// which is what the tests (running from src/) use.
//
// The grammars a plugin loads are the `{ pkg, wasm }` variants its manifest
// declares, read from the source so this list is never kept by hand. A wasm
// missing from node_modules (Pascal, Kotlin, Swift, Dart and Scala are built by
// `npm run setup`) is a warning for a local build and an error with --strict,
// which `prepublishOnly` passes: a package without it would leave a language
// unparsed for everyone who installs it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const out = join(root, "dist", "grammars");

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.name === "manifest.ts" || e.name === "meta.ts") yield p;
  }
}

const variants = new Map();
for (const file of files(join(root, "src", "extractors", "plugins"))) {
  for (const m of readFileSync(file, "utf8").matchAll(/pkg: "([^"]+)", wasm: "([^"]+)"/g)) variants.set(m[2], m[1]);
}
if (variants.size === 0) {
  console.error("copy-grammars: no grammar variants found in the plugin manifests");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const missing = [];
const licensed = new Set();
for (const [wasm, pkg] of variants) {
  const pkgDir = join(root, "node_modules", ...pkg.split("/"));
  const from = join(pkgDir, wasm);
  if (!existsSync(from)) {
    missing.push(`${pkg}/${wasm}`);
    continue;
  }
  copyFileSync(from, join(out, wasm));
  if (licensed.has(pkg)) continue;
  licensed.add(pkg);
  const licence = readdirSync(pkgDir).find((f) => /^(LICEN[CS]E|COPYING)/i.test(f));
  if (licence) copyFileSync(join(pkgDir, licence), join(out, `${pkg.replace(/^@/, "").replace(/\//g, "__")}.${licence}`));
}

if (missing.length) {
  const msg = `copy-grammars: no wasm for ${missing.join(", ")} — run \`npm run setup\` to build them`;
  if (strict) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(`${msg}; those languages will load from node_modules if it has them`);
}
console.log(`copy-grammars: ${variants.size - missing.length} of ${variants.size} grammars copied to dist/grammars/`);
