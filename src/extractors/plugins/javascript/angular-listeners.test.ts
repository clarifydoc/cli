import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { JsSubjectResolver } from "./subject-flows.js";
import { resolveAngularExternalTemplates } from "./angular-external-templates.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  return (await analyzeIn(files)).analyses;
}

async function analyzeIn(files: Record<string, string>): Promise<{ analyses: FileAnalysis[]; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "angular-listeners-"));
  const out = await mkdtemp(join(tmpdir(), "angular-listeners-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
    if (!rel.endsWith(".ts")) continue;
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "typescript" },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return { analyses, root };
}

const show = (l: { sourceFile: string; sourceSymbol: string; targetFile: string; targetSymbol: string }) => `${l.sourceFile}::${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`;

/**
 * Listeners on a service's subject that subscribe for the component's life without a `.subscribe` on the service's
 * own member: `toSignal(svc.x$.pipe(op(cb)))`, an inline template's `x$ | async` over a member built from the
 * subject, and a subscription through the component's own alias of the stream. A namesake service (`GarageService`,
 * same `changes$`) feeds only its own listeners.
 */
describe("Angular subject listeners through toSignal, | async and an own alias", () => {
  const service = (name: string) => `import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
@Injectable({ providedIn: 'root' })
export class ${name}Service {
  readonly changes$ = new Subject<string>();
  announce(c: string) { this.changes$.next(c); }
}`;
  const signalReader = (svc: string, file: string, route: string) => `import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { ${svc}Service } from './${file}';
@Component({ selector: 'app-${svc.toLowerCase()}-table', template: '' })
export class ${svc}TableComponent {
  private http = inject(HttpClient);
  private svc = inject(${svc}Service);
  readonly rows = toSignal(this.svc.changes$.pipe(switchMap(() => this.http.get('${route}'))));
}`;
  const asyncReader = (svc: string, file: string, route: string) => `import { Component } from '@angular/core';
import { switchMap } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { ${svc}Service } from './${file}';
@Component({ selector: 'app-${svc.toLowerCase()}-list', template: '<li *ngFor="let p of players$ | async">{{ p }}</li>' })
export class ${svc}ListComponent {
  constructor(private http: HttpClient, private svc: ${svc}Service) {}
  players$ = this.svc.changes$.pipe(switchMap(() => this.http.get('${route}')));
}`;
  const aliasReader = (svc: string, file: string) => `import { Component } from '@angular/core';
import { ${svc}Service } from './${file}';
@Component({ selector: 'app-${svc.toLowerCase()}-badge', template: '' })
export class ${svc}BadgeComponent {
  constructor(private svc: ${svc}Service) {
    this.stream$.subscribe(() => this.refresh());
  }
  get stream$() { return this.svc.changes$; }
  refresh() { return 1; }
}`;
  const files = {
    "src/league.service.ts": service("League"),
    "src/garage.service.ts": service("Garage"),
    "src/league-table.component.ts": signalReader("League", "league.service", "/api/standings"),
    "src/garage-table.component.ts": signalReader("Garage", "garage.service", "/api/cars"),
    "src/league-list.component.ts": asyncReader("League", "league.service", "/api/players"),
    "src/garage-list.component.ts": asyncReader("Garage", "garage.service", "/api/bays"),
    "src/league-badge.component.ts": aliasReader("League", "league.service"),
    "src/garage-badge.component.ts": aliasReader("Garage", "garage.service"),
  };

  it("runs each listener from a next on its own service's subject, and never the namesake's", async () => {
    const links = new JsSubjectResolver().resolve(await analyzeAll(files)).map(show);
    const from = (svc: string) => links.filter((l) => l.startsWith(`src/${svc}.service.ts::`)).map((l) => l.split(" -> ")[1]!.replace(/@\d+>/, "@N>")).sort();
    expect(from("league")).toEqual([
      "src/league-badge.component.ts::<subscribe@N>",
      "src/league-list.component.ts::<pipe@N>",
      "src/league-table.component.ts::<pipe@N>",
    ]);
    expect(from("garage")).toEqual([
      "src/garage-badge.component.ts::<subscribe@N>",
      "src/garage-list.component.ts::<pipe@N>",
      "src/garage-table.component.ts::<pipe@N>",
    ]);
  });

  it("holds the toSignal operator callback as a function that makes the request", async () => {
    const analyses = await analyzeAll(files);
    const table = analyses.find((a) => a.filePath === "src/league-table.component.ts")!;
    const held = table.functions.find((f) => /^<pipe@\d+>$/.test(f.name));
    expect(held?.calls.map((c) => c.name)).toContain("this.http.get");
  });
});

/**
 * The same `| async` listener when the stream is assigned in the constructor, and when the component keeps its
 * markup in an external `templateUrl` file (read only for what the template pipes through `async`).
 */
describe("Angular | async listeners: constructor assignment and external templates", () => {
  const service = (name: string) => `import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
@Injectable({ providedIn: 'root' })
export class ${name}Service {
  readonly changes$ = new Subject<string>();
  announce(c: string) { this.changes$.next(c); }
}`;
  const ctorReader = (svc: string, route: string) => `import { Component } from '@angular/core';
import { switchMap } from 'rxjs/operators';
import { Observable } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { ${svc}Service } from './${svc.toLowerCase()}.service';
@Component({ selector: 'app-${svc.toLowerCase()}-ctor', template: '<li *ngFor="let p of players$ | async">{{ p }}</li>' })
export class ${svc}CtorComponent {
  players$: Observable<unknown>;
  constructor(private http: HttpClient, private svc: ${svc}Service) {
    this.players$ = this.svc.changes$.pipe(switchMap(() => this.http.get('${route}')));
  }
}`;
  const externalReader = (svc: string, route: string, piped: string) => `import { Component } from '@angular/core';
import { switchMap } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { ${svc}Service } from './${svc.toLowerCase()}.service';
@Component({ selector: 'app-${svc.toLowerCase()}-ext', templateUrl: './${svc.toLowerCase()}-ext.component.html' })
export class ${svc}ExtComponent {
  constructor(private http: HttpClient, private svc: ${svc}Service) {}
  ${piped}$ = this.svc.changes$.pipe(switchMap(() => this.http.get('${route}')));
  unused$ = this.svc.changes$.pipe(switchMap(() => this.http.get('/api/never')));
}`;
  const files = {
    "src/league.service.ts": service("League"),
    "src/garage.service.ts": service("Garage"),
    "src/league-ctor.component.ts": ctorReader("League", "/api/players"),
    "src/garage-ctor.component.ts": ctorReader("Garage", "/api/bays"),
    "src/league-ext.component.ts": externalReader("League", "/api/fixtures", "fixtures"),
    "src/league-ext.component.html": '<li *ngFor="let f of fixtures$ | async">{{ f }}</li>',
    "src/garage-ext.component.ts": externalReader("Garage", "/api/cars", "cars"),
    "src/garage-ext.component.html": "<p>no stream here</p>",
  };

  it("runs a constructor-assigned stream read with | async, and only the service's own", async () => {
    const links = new JsSubjectResolver().resolve(await analyzeAll(files)).map(show);
    const from = links.filter((l) => l.startsWith("src/league.service.ts::")).map((l) => l.split(" -> ")[1]!.replace(/@\d+>/, "@N>"));
    expect(from).toContain("src/league-ctor.component.ts::<pipe@N>");
    expect(links.filter((l) => l.startsWith("src/garage.service.ts::")).map((l) => l.split(" -> ")[1]!)).not.toContain(expect.stringMatching(/league/));
  });

  it("runs a member an external template pipes through async, not one it leaves unread", async () => {
    const { analyses, root } = await analyzeIn(files);
    await resolveAngularExternalTemplates(analyses, root);
    const links = new JsSubjectResolver().resolve(analyses).map(show);
    const names = (svc: string) => links.filter((l) => l.startsWith(`src/${svc}.service.ts::`)).map((l) => l.split(" -> ")[1]!.replace(/@\d+>/, "@N>"));
    // `fixtures$` is read in league's template; `unused$` and everything of garage's (its template pipes nothing) is not.
    expect(names("league").filter((n) => n.includes("-ext.component"))).toEqual(["src/league-ext.component.ts::<pipe@N>"]);
    expect(names("garage").filter((n) => n.includes("-ext.component"))).toEqual([]);
    const ext = analyses.find((a) => a.filePath === "src/league-ext.component.ts")!;
    const heldCalls = links.length;
    expect(heldCalls).toBeGreaterThan(0);
    expect(ext.subjectFlows?.listens?.length).toBe(1);
  });
});
