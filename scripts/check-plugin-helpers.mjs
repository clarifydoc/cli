#!/usr/bin/env node
// Fails when the same helper body is declared in two plugin folders (a shared helper belongs in
// src/extractors/shared or src/extractors/plugins/shared, where each plugin imports it).
// A declaration is a top-level `function` of at least MIN_BODY normalized characters; bodies are compared
// with comments and whitespace removed and the declared name ignored. A body left on purpose goes in
// scripts/plugin-helpers-allow.json as { "bodyHash": "reason" } (the failing run prints the hash).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_BODY = 120;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = process.argv[2] ?? join(root, "src", "extractors", "plugins");
const allowPath = process.argv[3] ?? join(root, "scripts", "plugin-helpers-allow.json");

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) yield p;
  }
}

/** Top-level function declarations of a source text: { name, body } with the body from the parameter list on. */
function declarations(text) {
  const out = [];
  const re = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm;
  for (let m; (m = re.exec(text)); ) {
    const end = text.indexOf("\n}\n", m.index);
    if (end < 0) continue;
    const full = text.slice(m.index, end + 2);
    out.push({ name: m[1], body: full.slice(full.indexOf(m[1]) + m[1].length) });
  }
  return out;
}

function normalize(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/\s+/g, "");
}

function findDuplicates(files) {
  const byHash = new Map();
  for (const { path, text } of files) {
    const folder = relative(pluginsDir, path).split(sep)[0];
    for (const d of declarations(text)) {
      const norm = normalize(d.body);
      if (norm.length < MIN_BODY) continue;
      const hash = createHash("sha256").update(norm).digest("hex").slice(0, 12);
      const entry = byHash.get(hash) ?? [];
      entry.push({ folder, path: relative(pluginsDir, path), name: d.name });
      byHash.set(hash, entry);
    }
  }
  return [...byHash].filter(([, v]) => new Set(v.map((x) => x.folder)).size > 1);
}

const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")) : {};
const files = [...walk(pluginsDir)].map((path) => ({ path, text: readFileSync(path, "utf8") }));
const found = findDuplicates(files).filter(([hash]) => !(hash in allow));
if (found.length) {
  console.error("Identical helper bodies declared in more than one plugin folder:");
  for (const [hash, where] of found) {
    console.error(`  ${hash}`);
    for (const w of where) console.error(`    ${w.path}  ${w.name}`);
  }
  console.error("Move one copy to a shared module and import it, or add the hash to scripts/plugin-helpers-allow.json with the reason.");
  process.exit(1);
}
console.log(`plugin helpers: no identical body in two plugin folders (${files.length} files)`);
