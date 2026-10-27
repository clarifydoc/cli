#!/usr/bin/env node
// Build the npm tarball: a `clarifydoc` package that installs with no compiler,
// no Docker and no network beyond the tarball itself.
//
//   npm run build && node scripts/pack-standalone.mjs [--out <dir>]
//
// Why not `npm pack` on this repository: the grammar packages it depends on
// declare `install: node-gyp rebuild` for NATIVE bindings the analyzer never
// loads (it parses through web-tree-sitter + WASM), their peer ranges conflict
// (ERESOLVE), and two of them ship no .wasm at all — Pascal and Kotlin are
// compiled by `npm run setup`. `.npmrc` papers over all of that here, but an
// `.npmrc` does not travel with a published package.
//
// So the package is staged in `.pack/` with its whole production dependency
// closure BUNDLED (`bundleDependencies`): grammar packages trimmed to their
// package.json + .wasm with every lifecycle script removed, the native-only
// helpers left out, pure-JS dependencies copied whole. Installing it runs
// nothing and compiles nothing.
//
// Prints the tarball path. Fails if a grammar has no .wasm (run `npm run setup`).

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outDir = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : root);
const stage = join(root, ".pack");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Grammar packages are loaded as WASM; only package.json + *.wasm are read. */
const isGrammar = (name) => /(^|\/)tree-sitter-/.test(name);

/** Production dependencies that only serve native bindings the analyzer never loads. */
const SKIP = new Set([
  "tree-sitter-wasms",
  "tree-sitter-cpp",
  "tree-sitter-rust",
  "tree-sitter-vue",
  "tree-sitter-c",
  "tree-sitter-go",
  "nan",
  "node-addon-api",
  "node-gyp-build",
  // tree-sitter-swift's: the CLI that would build its native binding, and what finds it on the PATH.
  "tree-sitter-cli",
  "which",
  "isexe",
]);

function fail(msg) {
  console.error(`\n[pack-standalone] ${msg}\n`);
  process.exit(1);
}

if (!existsSync(join(root, "dist", "cli.js"))) fail("dist/cli.js not found — run `npm run build` first");

// ── The production dependency closure, as installed here ────────────────────
function closure() {
  let out;
  try {
    out = execSync("npm ls --omit=dev --all --parseable", { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    out = err?.stdout?.toString?.() ?? ""; // npm ls exits non-zero on peer warnings but still prints the tree
  }
  const dirs = [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter((p) => p && p !== root && p.includes("node_modules")))];
  if (dirs.length === 0) fail("could not read the dependency closure (npm ls)");
  return dirs;
}

const nameOf = (dir) => {
  const rel = dir.slice(dir.lastIndexOf("node_modules") + "node_modules".length + 1).split(/[\\/]/);
  return rel[0].startsWith("@") ? `${rel[0]}/${rel[1]}` : rel[0];
};

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

// ── Stage ───────────────────────────────────────────────────────────────────
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "node_modules"), { recursive: true });

cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true, filter: (src) => !src.endsWith(".map") });
// The LSP layer resolves each language server's Dockerfile at ../docker from dist/.
cpSync(join(root, "docker"), join(stage, "docker"), { recursive: true });
for (const f of ["README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md"]) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(stage, f));
}

const bundled = new Map(); // top-level name → version
const missingWasm = [];
for (const dir of closure()) {
  const name = nameOf(dir);
  if (SKIP.has(name)) continue;
  const to = join(stage, "node_modules", ...name.split("/"));
  mkdirSync(dirname(to), { recursive: true });
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (isGrammar(name)) {
    cpSync(dir, to, { recursive: true, filter: (src) => statSync(src).isDirectory() || src.endsWith(".wasm") || src.endsWith("package.json") });
    if (!walk(to).some((f) => f.endsWith(".wasm"))) missingWasm.push(name);
    // Nothing of the native build survives, so nothing may try to run it.
    for (const pj of walk(to).filter((f) => f.endsWith("package.json"))) {
      const p = JSON.parse(readFileSync(pj, "utf8"));
      delete p.scripts;
      delete p.gypfile;
      delete p.dependencies;
      delete p.peerDependencies;
      delete p.peerDependenciesMeta;
      delete p.optionalDependencies;
      // npm pack honours a bundled package's own `files`; Pascal's and
      // Kotlin's do not list the .wasm `npm run setup` built into them.
      delete p.files;
      writeFileSync(pj, JSON.stringify(p, null, 2) + "\n");
    }
  } else {
    cpSync(dir, to, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes("debug") });
  }
  if (pkg.dependencies?.[name]) bundled.set(name, meta.version);
}
if (missingWasm.length) fail(`no .wasm for grammar package(s): ${missingWasm.join(", ")} — run \`npm run setup\``);

// ── package.json: the published one ─────────────────────────────────────────
const published = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  keywords: pkg.keywords,
  license: pkg.license,
  repository: pkg.repository,
  homepage: pkg.homepage,
  bugs: pkg.bugs,
  type: pkg.type,
  bin: pkg.bin,
  main: pkg.main,
  types: pkg.types,
  engines: { node: ">=20" },
  // Exact versions: what was tested is what ships.
  dependencies: Object.fromEntries([...bundled].sort(([a], [b]) => a.localeCompare(b))),
  bundleDependencies: [...bundled.keys()].sort(),
};
writeFileSync(join(stage, "package.json"), JSON.stringify(published, null, 2) + "\n");

// ── Pack ────────────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outDir], { cwd: stage, encoding: "utf8" }))[0];
const tarball = join(outDir, packed.filename);
console.error(`[pack-standalone] ${packed.entryCount} files, ${(packed.size / 1024 / 1024).toFixed(1)} MB packed, ${(packed.unpackedSize / 1024 / 1024).toFixed(1)} MB unpacked`);
console.log(tarball);
