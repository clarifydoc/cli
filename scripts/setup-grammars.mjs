// Builds the tree-sitter WASM grammars that npm does NOT ship prebuilt.
//
// Every other grammar package (tree-sitter-java, tree-sitter-c-sharp, …) ships a
// `web-tree-sitter@0.27`-loadable `.wasm` in its tarball, which parser-manager.ts
// loads straight out of node_modules. `tree-sitter-pascal` and `tree-sitter-kotlin`
// ship only C sources, so their wasm has to be compiled locally — without it,
// Pascal/Delphi and Kotlin parsing throws ENOENT and ~29 tests fail.
//
// Needs Docker (or a local emcc) for emscripten. Run via `npm run setup` after
// any `npm install`, which wipes these files along with the rest of node_modules.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Grammar packages with no prebuilt wasm on npm — keep in sync with the plugin
 * manifests.
 */
const grammars = [
  { pkg: "tree-sitter-pascal", wasm: "tree-sitter-pascal.wasm" },
  { pkg: "tree-sitter-kotlin", wasm: "tree-sitter-kotlin.wasm" },
];

const run = (cmd, args) =>
  spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

// The CLI ships its binary via an install script, which `ignore-scripts` skips.
const cliDir = join(root, "node_modules", "tree-sitter-cli");
const cliBin = join(cliDir, process.platform === "win32" ? "tree-sitter.exe" : "tree-sitter");
if (!existsSync(cliBin)) {
  console.log("setup-grammars: fetching the tree-sitter CLI binary");
  if (run("npm", ["rebuild", "tree-sitter-cli", "--ignore-scripts=false"]).status !== 0) {
    console.error("setup-grammars: could not install the tree-sitter CLI binary");
    process.exit(1);
  }
}

let built = 0;
for (const { pkg, wasm } of grammars) {
  const pkgDir = join(root, "node_modules", pkg);
  const out = join(pkgDir, wasm);
  if (existsSync(out)) continue;
  if (!existsSync(pkgDir)) {
    console.error(`setup-grammars: ${pkg} is not installed — run \`npm install --ignore-scripts\` first`);
    process.exit(1);
  }
  console.log(`setup-grammars: building ${wasm} (emscripten via Docker, ~1 min)`);
  if (run(cliBin, ["build", "--wasm", "-o", out, pkgDir]).status !== 0 || !existsSync(out)) {
    console.error(`setup-grammars: failed to build ${wasm}. Emscripten needs Docker running (or emcc on PATH).`);
    process.exit(1);
  }
  built++;
}

console.log(built ? `setup-grammars: built ${built} grammar(s)` : "setup-grammars: all grammars present");
