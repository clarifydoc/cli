#!/usr/bin/env node
// Source patches a grammar package needs before its wasm is built, applied by
// setup-grammars.mjs (to a copy) and by the root Dockerfile's grammar stage:
//
//   node scripts/grammar-patches.mjs <package> <dir>     # patches <dir> in place
//
// Each patch fails loudly when the source no longer looks as it expects, so an
// upgrade of the package cannot silently build an unpatched grammar.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Swift's external scanner, made loadable by web-tree-sitter: it reports running out of memory through
 * `fprintf(stderr)` + `exit`, which a Wasm parser cannot link, and an empty `deserialize` — how each parse
 * starts — leaves the previous parse's raw-string state in place. (Before 0.7.4 it also allocated its state
 * with `calloc(0, …)`, so in Wasm every parse after the first read a corrupted scanner.)
 */
export function patchSwiftScanner(source) {
  const patched = source
    .replace(/if \(!payload\) \{\s*fprintf\(stderr,[^;]*;\s*exit\(1\);\s*\}/, "if (!payload) {\n        return NULL;\n    }")
    .replace(/(\n\s*)if \(length < 4\) \{\s*return;\s*\}/, "$1if (length < 4) {$1    ((struct ScannerState *)payload)->ongoing_raw_str_hash_count = 0;$1    return;$1}");
  if (/\b(fprintf|exit)\(/.test(patched) || !patched.includes("ongoing_raw_str_hash_count = 0;\n        return;")) {
    throw new Error("tree-sitter-swift's scanner changed — update patchSwiftScanner in scripts/grammar-patches.mjs");
  }
  return patched;
}

/** Per package: the file to rewrite, relative to the package root, and how. */
export const GRAMMAR_PATCHES = {
  "tree-sitter-swift": { "src/scanner.c": patchSwiftScanner },
};

/** Rewrites `dir`'s files as `pkg`'s patches say; a package with none is left alone. */
export function applyGrammarPatches(pkg, dir) {
  for (const [file, rewrite] of Object.entries(GRAMMAR_PATCHES[pkg] ?? {})) {
    writeFileSync(join(dir, file), rewrite(readFileSync(join(dir, file), "utf8")));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pkg, dir] = process.argv.slice(2);
  if (!pkg || !dir) {
    console.error("usage: node scripts/grammar-patches.mjs <package> <dir>");
    process.exit(1);
  }
  applyGrammarPatches(pkg, dir);
}
