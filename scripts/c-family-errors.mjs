#!/usr/bin/env node
/**
 * The first error of each C/C++ file the grammars refuse, as the reader sees it: the last attempt of the
 * conditional handling (branches resolved), with file:line:column and the offending token, then the failures grouped
 * by cause. Usage: node scripts/c-family-errors.mjs <repo-dir> [--json <file>] [--first]
 * Reads cli/src directly (TypeScript run in place, no build needed; it re-runs itself with the flags that takes), and
 * only re-parses files the readers really reject, to catch where. `--first` reports the first attempt's error (the
 * conditionals as written) instead of the last. A cause is `parse <token>`, `lexer`, or `full-context budget`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SCRIPTS, listFiles, nameOf, option, positional, table } from "./lib/c-family.mjs";

if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", pathToFileURL(join(SCRIPTS, "lib", "ts-register.mjs")).href, ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const src = (p) => import(pathToFileURL(join(SCRIPTS, "..", "src", p)).href);
const [{ BaseErrorListener, BailErrorStrategy }, { parseWithAntlr, normalizeSource }, { readWithBranches }, { CLexer }, { CParser }, { CPP14Lexer }, { CPP14Parser }, { readC }, { readCpp }] = await Promise.all([
  import("antlr4ng"),
  src("parsers/antlr/run.ts"),
  src("extractors/plugins/shared/preprocessor-branches.ts"),
  src("parsers/antlr/c/CLexer.ts"),
  src("parsers/antlr/c/CParser.ts"),
  src("parsers/antlr/cpp/CPP14Lexer.ts"),
  src("parsers/antlr/cpp/CPP14Parser.ts"),
  src("extractors/plugins/c/antlr.ts"),
  src("extractors/plugins/cpp/antlr.ts"),
]);

const argv = process.argv.slice(2);
const dir = positional(argv, ["json"])[0];
if (!dir) throw new Error("usage: c-family-errors.mjs <repo-dir> [--json <file>] [--first]");

class LexerSink extends BaseErrorListener {
  constructor(rec) {
    super();
    this.rec = rec;
  }
  syntaxError(_r, _t, line, column, msg) {
    this.rec.lexer ??= { line, column, text: msg };
  }
}

/** Parse errors are thrown by a bailing strategy; wrap it to note where, since the exception carries no position out of `parseWithAntlr`. */
function watch(parser, rec) {
  let handler = parser.errorHandler;
  const noteAt = (token) => (rec.parse = { line: token?.line ?? 0, column: token?.column ?? 0, text: printable(token?.text ?? "<eof>") });
  Object.defineProperty(parser, "errorHandler", {
    get: () => handler,
    set: (h) => {
      handler =
        h instanceof BailErrorStrategy
          ? new Proxy(h, {
              get(t, p) {
                if (p === "recover") return (r, e) => (noteAt(e?.offendingToken ?? r.getCurrentToken()), t.recover(r, e));
                if (p === "recoverInline") return (r) => (noteAt(r.getCurrentToken()), t.recoverInline(r));
                const v = t[p];
                return typeof v === "function" ? v.bind(t) : v;
              },
            })
          : h;
    },
    configurable: true,
  });
  const reset = parser.reset.bind(parser);
  parser.reset = (...a) => ((rec.parse = null), reset(...a));
}

/** A reader like the engine's `read`, parse only, keeping each attempt's first error. */
function reader(Lexer, Parser, entry, attempts) {
  return (text) => {
    const rec = { lexer: null, parse: null };
    const { tree, errors } = parseWithAntlr(
      text,
      (input) => {
        const lexer = new Lexer(input);
        lexer.removeErrorListeners();
        lexer.removeErrorListeners = () => {};
        lexer.addErrorListener(new LexerSink(rec));
        return lexer;
      },
      (tokens) => {
        const parser = new Parser(tokens);
        parser.prepare(tokens);
        watch(parser, rec);
        return parser;
      },
      (parser) => parser[entry](),
      { firstError: true },
    );
    attempts.push({ errors, tree: tree !== null, rec });
    return { functions: [], topLevelCalls: [], syntaxErrors: errors };
  };
}

// Mirrors plugins/cpp/antlr.ts: a header with no C++ in it is read again as C.
const CPP_ONLY = /::|\btemplate\s*<|\bnamespace\s+\w*\s*\{|\bclass\s+\w+\s*[:{]/;
const codeOnly = (t) => t.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, " ");
const RAW_STRING = /(?<![\w\\"'])(?:u8|u|U|L)?R"([^ ()\\\t\v\f\n"]{0,16})\(/g;
function blankRawStrings(text) {
  if (!text.includes('R"')) return text;
  let out = "";
  let at = 0;
  for (const m of text.matchAll(RAW_STRING)) {
    if (m.index < at) continue;
    const close = text.indexOf(`)${m[1]}"`, m.index + m[0].length);
    if (close < 0) continue;
    const end = close + m[1].length + 2;
    out += text.slice(at, m.index) + '""' + text.slice(m.index + 2, end).replace(/[^\n]/g, " ");
    at = end;
  }
  return out + text.slice(at);
}

/** Where the attempt failed: `{ kind, line, column, token }`. */
const printable = (t) => t.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

function site(attempt) {
  const { rec } = attempt;
  if (rec.lexer) return { kind: "lexer", ...rec.lexer, token: printable(rec.lexer.text.replace(/^token recognition error at: /, "")) };
  if (rec.parse) return { kind: "parse", line: rec.parse.line, column: rec.parse.column, token: rec.parse.text };
  return { kind: "budget", line: 0, column: 0, token: "" };
}

const first = argv.includes("--first");
const engine = await import(pathToFileURL(join(SCRIPTS, "lib", "c-family.mjs")).href);
const rows = [];
let checked = 0;
for (const f of listFiles(dir)) {
  const source = readFileSync(f.abs, "utf8");
  if (source.length > engine.MAX_CHARS) continue;
  checked++;
  const real = f.group === "c" ? readC(source) : readCpp(source);
  if (real.syntaxErrors === 0) continue;
  const attempts = [];
  if (f.group === "c") readWithBranches(normalizeSource(source), false, reader(CLexer, CParser, "compilationUnit", attempts));
  else readWithBranches(blankRawStrings(normalizeSource(source)), true, reader(CPP14Lexer, CPP14Parser, "translationUnit", attempts));
  const at = first ? attempts[0] : attempts.at(-1);
  if (!at) continue;
  const s = site(at);
  const lineText = (readFileSync(f.abs, "utf8").split(/\r?\n/)[s.line - 1] ?? "").trim().slice(0, 110);
  rows.push({ file: f.rel, group: f.group, attempts: attempts.length, ...s, lineText, cause: s.kind === "parse" ? `parse ${s.token}` : s.kind === "lexer" ? `lexer ${s.token}` : "full-context budget" });
}
console.log(`${nameOf(dir)}: ${checked} files checked, ${rows.length} refused (${first ? "first attempt" : "last attempt, conditionals resolved"})`);
for (const r of rows) console.log(`${r.file}:${r.line}:${r.column}\t${r.cause}\t[${r.group}, ${r.attempts} attempt${r.attempts === 1 ? "" : "s"}]\t${r.lineText}`);
const groups = new Map();
for (const r of rows) groups.set(r.cause, [...(groups.get(r.cause) ?? []), r]);
if (rows.length > 0) {
  console.log("\nGrouped by first-error token:");
  console.log(table([...groups].sort((a, b) => b[1].length - a[1].length).map(([cause, list]) => [cause, list.length, `${list[0].file}:${list[0].line}`]), ["cause", "files", "example"]));
}
const json = option(argv, "json");
if (json) writeFileSync(json, JSON.stringify({ dir: nameOf(dir), rows }, null, 2));
