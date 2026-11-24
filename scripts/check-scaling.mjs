#!/usr/bin/env node
// Quadratic-slowdown check: analyze generated input at N and 4N sub-projects and fail when the
// cost grows faster than linearly.
//
//   node scripts/check-scaling.mjs [--projects 30] [--max-ratio 2.5] [--runs 2] [--keep]
//
// Run from cli/ against the built CLI (`npm run build` first). Fixtures cannot catch this kind of
// regression: their input is far too small for a pass that is quadratic in files, sub-projects,
// routes or links to show. The input here is generated, in three languages, as many small
// sub-projects (each its own manifest) with a fixed number of files each, so N and 4N differ only
// in how many of them there are.
//
// Measure: wall clock of a single-threaded run (CLARIFYDOC_WORKERS=0, so wall is CPU), the best
// of `--runs`, minus the run of a one-project tree (start-up and fixed work). The ratio is
//   (t(4N) - t(1)) / (t(N) - t(1)) / 4
// which is 1.0 for a linear analysis; the default limit 2.5 leaves room for noise and for
// n log n passes. A ratio above it prints the stage timings of both runs, so the stage that grew
// can be read off.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const N = Number(opt("projects", 30));
const MAX_RATIO = Number(opt("max-ratio", 2.5));
const RUNS = Number(opt("runs", 2));
const keep = args.includes("--keep");
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const CLUBS = ["Rovers", "United", "City", "Wanderers", "Athletic", "Albion", "Rangers", "Town"];
const CARS = ["Sedan", "Coupe", "Wagon", "Roadster", "Hatchback", "Pickup", "Cabriolet", "Minivan"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** Files of sub-project `i`: one language by `i % 3`, same shape for every project of that language. */
function project(i) {
  const club = CLUBS[i % CLUBS.length];
  const car = CARS[i % CARS.length];
  const dir = `${["web", "api", "svc"][i % 3]}-${club.toLowerCase()}-${i}`;
  const files = {};
  const lang = i % 3;
  if (lang === 0) {
    files[`${dir}/package.json`] = JSON.stringify({ name: `${dir}`, dependencies: { express: "^4.18.0", react: "^18.0.0" } });
    files[`${dir}/server.ts`] =
      `import express from "express";\nimport { find${club}Players, save${club}Player } from "./players";\nconst app = express();\n` +
      `app.get("/api/${dir}/players", (req, res) => res.json(find${club}Players()));\n` +
      `app.post("/api/${dir}/players", (req, res) => res.json(save${club}Player(req.body)));\n`;
    files[`${dir}/players.ts`] =
      `import { db } from "./db";\nexport function find${club}Players() { return db.query("SELECT * FROM ${club.toLowerCase()}_players"); }\n` +
      `export function save${club}Player(p: unknown) { return db.query("INSERT INTO ${club.toLowerCase()}_players VALUES (1)"); }\n`;
    files[`${dir}/db.ts`] = `export const db = { query(sql: string) { return [sql]; } };\n`;
    files[`${dir}/Page.tsx`] =
      `import React from "react";\nexport function ${club}Page() {\n  const load = () => fetch("/api/${dir}/players");\n  return <button onClick={load}>Load</button>;\n}\n`;
  } else if (lang === 1) {
    files[`${dir}/pyproject.toml`] = `[project]\nname = "${dir}"\ndependencies = ["fastapi"]\n`;
    files[`${dir}/app.py`] =
      `from fastapi import FastAPI\nfrom .repo import list_${car.toLowerCase()}s\napp = FastAPI()\n\n@app.get("/api/${dir}/cars")\ndef cars():\n    return list_${car.toLowerCase()}s()\n`;
    files[`${dir}/repo.py`] = `def list_${car.toLowerCase()}s():\n    return execute("SELECT * FROM ${car.toLowerCase()}_garage")\n\ndef execute(sql):\n    return [sql]\n`;
    files[`${dir}/__init__.py`] = "";
  } else {
    files[`${dir}/go.mod`] = `module example.com/${dir}\n\ngo 1.22\n`;
    files[`${dir}/main.go`] =
      `package main\n\nimport "net/http"\n\nfunc main() {\n\thttp.HandleFunc("/api/${dir}/matches", list${club}Matches)\n}\n\nfunc list${club}Matches(w http.ResponseWriter, r *http.Request) {\n\tsave${club}Report()\n}\n`;
    files[`${dir}/report.go`] = `package main\n\nfunc save${club}Report() {\n\tdb.Exec("INSERT INTO ${club.toLowerCase()}_reports VALUES (1)")\n}\n\nvar db = struct{ Exec func(string) }{}\n`;
  }
  return files;
}

function generate(root, n) {
  for (let i = 0; i < n; i++) {
    for (const [rel, text] of Object.entries(project(i))) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  }
}

function run(root, label) {
  let best = Infinity;
  let stages = "";
  for (let r = 0; r < RUNS; r++) {
    const out = join(root, "..", `out-${label}-${r}`);
    const t0 = process.hrtime.bigint();
    const res = spawnSync(process.execPath, [cli, "analyze", root, "-o", out, "--no-lsp", "--no-git-history", "--verbose"], {
      env: { ...process.env, CLARIFYDOC_WORKERS: "0" },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const sec = Number(process.hrtime.bigint() - t0) / 1e9;
    if (res.status !== 0) {
      console.error(`analyze failed on ${label} (exit ${res.status})\n${(res.stdout || "").slice(-1500)}\n${(res.stderr || "").slice(-1500)}`);
      process.exit(2);
    }
    if (sec < best) {
      best = sec;
      stages = ((res.stdout || "").match(/Timings:.*/) || [""])[0];
    }
  }
  return { sec: best, stages };
}

const base = mkdtempSync(join(tmpdir(), "scaling-"));
try {
  const sizes = { one: 1, n: N, n4: 4 * N };
  const timing = {};
  for (const [label, n] of Object.entries(sizes)) {
    const root = join(base, label, "src");
    mkdirSync(root, { recursive: true });
    generate(root, n);
    timing[label] = run(root, label);
    console.log(`${String(n).padStart(4)} sub-projects: ${timing[label].sec.toFixed(2)} s`);
  }
  const fixed = timing.one.sec;
  const grow = Math.max(timing.n.sec - fixed, 0.05);
  const ratio = (timing.n4.sec - fixed) / grow / 4;
  console.log(`normalized ratio (4N cost / (4 x N cost), fixed start-up removed): ${ratio.toFixed(2)} (limit ${MAX_RATIO})`);
  if (ratio > MAX_RATIO) {
    console.error(`FAIL: cost grows superlinearly.\nN:  ${timing.n.stages}\n4N: ${timing.n4.stages}`);
    process.exitCode = 1;
  }
} finally {
  if (!keep) rmSync(base, { recursive: true, force: true });
  else console.log(`kept ${base}`);
}
