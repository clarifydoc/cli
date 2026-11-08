import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyze(src: string): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "subjects-"));
  await writeFile(join(root, "club-list.component.ts"), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, "club-list.component.ts"), relativePath: "club-list.component.ts", language: "typescript" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "subjects-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

const callsOf = (a: FileAnalysis, name: string) => a.classes.flatMap((c) => c.methods).find((m) => m.name === name)!.calls.map((c) => c.name);

describe("RxJS subjects fed and subscribed in one class", () => {
  const src = `import { Component } from '@angular/core';
import { Subject } from 'rxjs';
import { debounceTime, switchMap } from 'rxjs/operators';
import { ClubService } from './club.service';

@Component({ selector: 'app-club-list', template: '' })
export class ClubListComponent {
  reload$ = new Subject<boolean>();
  other$ = new Subject<boolean>();
  shown$ = this.other$.asObservable();
  constructor(private clubs: ClubService, private players: PlayerService) {
    this.reload$
      .pipe(debounceTime(100), switchMap(() => this.clubs.list()))
      .subscribe((r) => { this.items = r.map((c) => c.name); });
    this.shown$.subscribe(() => this.players.refresh());
  }
  onSort() { this.reload$.next(true); }
  onOther() { this.other$.next(true); }
  onNothing() { this.items = []; }
}`;

  it("runs the subscriber's project calls from the handler that calls next (INFERRED), operators excluded", async () => {
    const a = await analyze(src);
    expect(callsOf(a, "onSort")).toEqual(expect.arrayContaining(["this.reload$.next", "this.clubs.list"]));
    expect(callsOf(a, "onSort")).not.toContain("switchMap");
    expect(callsOf(a, "onSort")).not.toContain("this.players.refresh");
    const trigger = a.classes[0]!.methods.find((m) => m.name === "onSort")!.calls.find((c) => c.name === "this.clubs.list")!;
    expect(trigger.confidence).toBe("INFERRED");
  });

  it("follows an asObservable alias, and gives a handler of an unrelated subject nothing", async () => {
    const a = await analyze(src);
    expect(callsOf(a, "onOther")).toContain("this.players.refresh");
    expect(callsOf(a, "onOther")).not.toContain("this.clubs.list");
    expect(callsOf(a, "onNothing")).toEqual([]);
  });
});

describe("a function or Observable held by a descriptor literal of the class", () => {
  const src = `import { Component } from '@angular/core';
import { ClubService } from './club.service';

@Component({ selector: 'app-club-tasks', template: '' })
export class ClubTasksComponent {
  tasks = [{ name: 'convert', api: this.clubs.convert() }];
  actions = [
    { title: 'rename', callback: (id: number) => this.clubs.rename(id) },
    { title: 'drop', callback: (id: number) => this.players.drop(id) },
  ];
  constructor(private clubs: ClubService, private players: PlayerService) {}
  runTask(task: { api: any }) { task.api.subscribe(); }
  act(item: any) { item.callback(1); }
  other(thing: any) { thing.name.length; thing.label(); this.clubs.list(); }
}`;

  it("links an Observable value to the call through the element (INFERRED when one value states it)", async () => {
    const a = await analyze(src);
    const run = a.classes[0]!.methods.find((m) => m.name === "runTask")!.calls.find((c) => c.name === "this.clubs.convert");
    expect(run?.confidence).toBe("INFERRED");
  });

  it("links each value two descriptors hold under a key, AMBIGUOUS, and nothing for a key no descriptor holds", async () => {
    const a = await analyze(src);
    const act = a.classes[0]!.methods.find((m) => m.name === "act")!.calls.filter((c) => c.name !== "item.callback");
    expect(act.map((c) => `${c.name}:${c.confidence}`).sort()).toEqual(["this.clubs.rename:AMBIGUOUS", "this.players.drop:AMBIGUOUS"]);
    expect(callsOf(a, "other")).toEqual(["thing.label", "this.clubs.list"]);
  });
});
