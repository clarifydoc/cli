/**
 * Function members joined by declared type, through the real per-file pipeline and the linker: an object literal
 * handed to a parameter (or a state hook) typed as an interface gives its function members to every reader of that
 * interface's member, and a namesake interface in another file stays apart.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>, language: Language = "typescript"): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "vf-typed-"));
  const out = await mkdtemp(join(tmpdir(), "vf-typed-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: rel.endsWith("x") ? "typescript" : language },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

const flow = (links: SymbolLink[]): string[] =>
  links.filter((l) => l.strategy === "value-flow").map((l) => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`).sort();

describe("value-flow (js): function members joined by declared type", () => {
  const files = {
    "src/notice.ts": [
      "export interface CrowdNoticeAction { onClick: () => void }",
      "export interface CrowdNotice { message: string; action?: CrowdNoticeAction }",
      "export const boardNotice: CrowdNotice = { message: '' };",
      "export function setCrowdNotice(notice: CrowdNotice, kind: string, options?: CrowdNotice) {",
      "  notice.message = options?.message ?? '';",
      "  notice.action = options?.action;",
      "}",
      "export function showCrowdNotice() {",
      "  boardNotice.action?.onClick();",
      "}",
      "",
    ].join("\n"),
    "src/club.ts": [
      "import { setCrowdNotice, boardNotice } from './notice';",
      "export function reopenMatch() { return 1; }",
      "export function save() {",
      "  setCrowdNotice(boardNotice, 'info', { message: 'Saved', action: { onClick: reopenMatch } });",
      "}",
      "",
    ].join("\n"),
    "src/decoy.ts": [
      "export interface CrowdNotice { message: string; action?: { onClick: () => void } }",
      "export function decoyHandler() { return 1; }",
      "export function other(t: CrowdNotice) { t.action?.onClick(); }",
      "export function make(): CrowdNotice { return { message: '', action: { onClick: decoyHandler } }; }",
      "export const d: CrowdNotice = { message: '', action: { onClick: decoyHandler } };",
      "",
    ].join("\n"),
  };
  it("joins the literal handed to a typed parameter with the reader of the interface member, never the namesake", async () => {
    const links = buildSymbolLinks(await analyzeAll(files));
    expect(flow(links)).toEqual(["showCrowdNotice@9 boardNotice.action?.onClick -> src/club.ts::reopenMatch"]);
  });

  it("passes a local object on the same way, and links nothing when the formal states no type", async () => {
    const typed = {
      ...files,
      "src/club.ts": [
        "import { setCrowdNotice, boardNotice } from './notice';",
        "export function reopenMatch() { return 1; }",
        "export function save() {",
        "  const opts = { message: 'Saved', action: { onClick: reopenMatch } };",
        "  setCrowdNotice(boardNotice, 'info', opts);",
        "}",
        "",
      ].join("\n"),
    };
    expect(flow(buildSymbolLinks(await analyzeAll(typed)))).toEqual(["showCrowdNotice@9 boardNotice.action?.onClick -> src/club.ts::reopenMatch"]);
    const untyped = { ...typed, "src/notice.ts": (typed["src/notice.ts"] as string).replace("options?: CrowdNotice", "options?: unknown") };
    expect(flow(buildSymbolLinks(await analyzeAll(untyped)))).toEqual([]);
  });

  const notify = {
    "src/substitution.ts": [
      "export interface Substitution { text: string; onClick: () => void }",
      "export function show(substitution: Substitution) {",
      "  const { onClick } = substitution;",
      "  onClick();",
      "}",
      "",
    ].join("\n"),
    "src/page.tsx": [
      "import { useState } from 'react';",
      "import type { Substitution } from './substitution';",
      "function openPlayer() { return 1; }",
      "export function Page() {",
      "  const [n] = useState<Substitution>({ text: 'hi', onClick: openPlayer });",
      "  return n;",
      "}",
      "",
    ].join("\n"),
    "src/decoy.ts": [
      "export interface Substitution { text: string; onClick: () => void }",
      "export function decoyOpen() { return 1; }",
      "export function use(n: Substitution) { n.onClick(); }",
      "export const d: Substitution = { text: '', onClick: decoyOpen };",
      "",
    ].join("\n"),
  };
  it("joins a literal stored with a typed state hook with a component that destructures the member", async () => {
    const links = buildSymbolLinks(await analyzeAll(notify));
    expect(flow(links)).toContain("show@4 onClick -> src/page.tsx::openPlayer");
    expect(flow(links).filter((l) => l.includes("decoyOpen") && l.startsWith("show@"))).toEqual([]);
  });

  it("keeps the exact link of a path through an imported name when a literal elsewhere writes that member key (real-repo FP)", async () => {
    const kit = {
      "src/kit.ts": [
        "export const Bench = { label: () => 'Bench', id: -2 };",
        "",
      ].join("\n"),
      "src/board.ts": [
        "import * as kit from './kit';",
        "export function options() { return [{ text: kit.Bench.label() }]; }",
        "",
      ].join("\n"),
      "src/menu.ts": [
        "function show(entry: object) { return entry; }",
        "function pick() { return 1; }",
        "export function open() { return show({ label: { text: 'Squad' }, onPick: pick }); }",
        "",
      ].join("\n"),
    };
    const links = buildSymbolLinks(await analyzeAll(kit));
    expect(links.filter((l) => l.sourceSymbol === "options" && l.callName === "kit.Bench.label").map((l) => l.targetFile))
      .toEqual(["src/kit.ts"]);
  });

  it("never links a wrapper to itself when it reads the member it then replaces (real-repo FP)", async () => {
    const wrap = {
      "src/whistle.ts": [
        "export interface Whistle { blow?: (minute: number) => boolean }",
        "export const mergeWhistles = (home: Whistle, away: Whistle) => {",
        "  const { blow: awayBlow } = away;",
        "  const { blow: homeBlow } = home;",
        "  home.blow = (minute: number) => {",
        "    if (awayBlow && awayBlow(minute)) return true;",
        "    return homeBlow ? homeBlow(minute) : false;",
        "  };",
        "};",
        "",
      ].join("\n"),
    };
    const links = buildSymbolLinks(await analyzeAll(wrap)).filter((l) => l.strategy === "value-flow");
    expect(links.filter((l) => l.sourceFile === l.targetFile && l.sourceSymbol === l.targetSymbol)
      .map((l) => `${l.sourceSymbol} ${l.callName}`)).toEqual([]);
  });
});
