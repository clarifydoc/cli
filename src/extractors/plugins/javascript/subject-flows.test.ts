import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { analyzeFile } from "../../../core/file-analyzer.js";
import { reactiveTriggerLinks } from "../../../core/reactive-triggers.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { JsSubjectResolver } from "./subject-flows.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "subject-flows-"));
  const out = await mkdtemp(join(tmpdir(), "subject-flows-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
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
  return analyses;
}

const show = (l: { sourceFile: string; sourceSymbol: string; targetFile: string; targetSymbol: string }) => `${l.sourceFile}::${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`;

describe("Angular signals read through toObservable", () => {
  const component = (name: string, extra = "") => `import { Component, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs';
import { HttpClient } from '@angular/common/http';

@Component({ selector: 'app-${name}', template: '' })
export class ${name}Component {
  clubId = signal(0);
  items: unknown[] = [];
  constructor(private http: HttpClient) {
    toObservable(this.clubId).pipe(switchMap(() => this.http.get('/api/players'))).subscribe((r) => { this.items = r as unknown[]; });
  }
  ${extra}
}`;

  it("runs the operators' callbacks and the subscriber's when the class writes the signal, and no other class's", async () => {
    const analyses = await analyzeAll({
      "src/club-list.component.ts": component("ClubList", "pick(id: number) { this.clubId.set(id); }\n  bump() { this.clubId.update((n) => n + 1); }"),
      // same signal name in another component, written nowhere there
      "src/car-list.component.ts": component("CarList", "refresh() { this.items = []; }"),
    });
    const links = reactiveTriggerLinks(analyses).map(show);
    expect(links).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/club-list\.component\.ts::ClubListComponent\.pick -> src\/club-list\.component\.ts::<pipe@\d+>/),
        expect.stringMatching(/club-list\.component\.ts::ClubListComponent\.bump -> src\/club-list\.component\.ts::<pipe@\d+>/),
      ]),
    );
    expect(links.filter((l) => l.includes("car-list"))).toEqual([]);
  });

  it("follows a field holding toObservable(this.sig)", async () => {
    const analyses = await analyzeAll({
      "src/club-list.component.ts": `import { Component, signal, computed } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
@Component({ selector: 'app-club-list', template: '' })
export class ClubListComponent {
  clubId = signal(0);
  label = computed(() => 'c' + this.clubId());
  label$ = toObservable(this.label);
  constructor(private clubs: ClubService) { this.label$.subscribe(() => this.clubs.list()); }
  pick(id: number) { this.clubId.set(id); }
}`,
    });
    expect(reactiveTriggerLinks(analyses).map(show).join("\n")).toMatch(/ClubListComponent\.pick -> src\/club-list\.component\.ts::<subscribe@\d+>/);
  });
});

describe("a Subject a service holds, fed and listened to across classes", () => {
  const service = (name: string) => `import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ${name}Service {
  readonly changes$ = new Subject<string>();
  announce(c: string) { this.changes$.next(c); }
}`;
  const listener = (service: string, file: string, route: string) => `import { Component } from '@angular/core';
import { switchMap } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { ${service}Service } from './${file}';

@Component({ selector: 'app-x', template: '' })
export class ${service}ListenerComponent {
  constructor(private http: HttpClient, private svc: ${service}Service) {
    this.svc.changes$.pipe(switchMap(() => this.http.get('${route}'))).subscribe();
  }
}`;
  const files = {
    "src/league.service.ts": service("League"),
    "src/garage.service.ts": service("Garage"),
    "src/club-detail.component.ts": listener("League", "league.service", "/api/matches"),
    "src/car-detail.component.ts": listener("Garage", "garage.service", "/api/cars"),
    "src/club-form.component.ts": `import { Component } from '@angular/core';
import { LeagueService } from './league.service';
@Component({ selector: 'app-club-form', template: '' })
export class ClubFormComponent {
  private league = inject(LeagueService);
  rename() { this.league.changes$.next('x'); }
  other() { this.league.announce('y'); }
}`,
  };

  it("runs the listeners of the service's subject from a next through the service or in it, by type", async () => {
    const links = new JsSubjectResolver().resolve(await analyzeAll(files)).map(show);
    expect(links.sort()).toEqual([
      "src/club-form.component.ts::ClubFormComponent.rename -> src/club-detail.component.ts::<pipe@9>",
      "src/garage.service.ts::GarageService.announce -> src/car-detail.component.ts::<pipe@9>",
      "src/league.service.ts::LeagueService.announce -> src/club-detail.component.ts::<pipe@9>",
    ]);
  });

  it("joins a listener on an asObservable member to the subject behind it", async () => {
    const links = new JsSubjectResolver()
      .resolve(
        await analyzeAll({
          ...files,
          "src/league.service.ts": `import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
@Injectable({ providedIn: 'root' })
export class LeagueService {
  private readonly changes = new Subject<string>();
  readonly changes$ = this.changes.asObservable();
  announce(c: string) { this.changes.next(c); }
}`,
        }),
      )
      .map(show);
    expect(links).toContain("src/league.service.ts::LeagueService.announce -> src/club-detail.component.ts::<pipe@9>");
    expect(links.filter((l) => l.includes("car-detail"))).toEqual(["src/garage.service.ts::GarageService.announce -> src/car-detail.component.ts::<pipe@9>"]);
  });

  it("joins a service and its listener declared in one file", async () => {
    const links = new JsSubjectResolver()
      .resolve(
        await analyzeAll({
          "src/league.ts": `import { Subject } from 'rxjs';
import { Component } from '@angular/core';
export class LeagueService {
  changes$ = new Subject<string>();
  announce(c: string) { this.changes$.next(c); }
}
@Component({ selector: 'app-x', template: '' })
export class ClubDetailComponent {
  constructor(private svc: LeagueService, private clubs: ClubService) {
    this.svc.changes$.subscribe(() => this.clubs.list());
  }
}`,
        }),
      )
      .map(show);
    expect(links).toEqual(["src/league.ts::LeagueService.announce -> src/league.ts::<subscribe@10>"]);
  });

  const serviceWith = (body: string) => `import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
@Injectable({ providedIn: 'root' })
export class LeagueService {
${body}
  announce(c: string) { this.changes.next(c); }
}`;
  const chained = async (body: string, extra: Record<string, string> = {}) =>
    new JsSubjectResolver().resolve(await analyzeAll({ ...files, ...extra, "src/league.service.ts": serviceWith(body) })).map(show);
  const announce = "src/league.service.ts::LeagueService.announce -> src/club-detail.component.ts::<pipe@9>";

  it("follows an alias of an alias, and a pipe or shareReplay on the way", async () => {
    expect(await chained(`  private readonly changes = new Subject<string>();
  private readonly a$ = this.changes.asObservable().pipe(shareReplay(1));
  readonly changes$ = this.a$;`)).toContain(announce);
    expect(await chained(`  private readonly changes = new Subject<string>();
  readonly changes$ = this.changes.pipe(map((x) => x));`)).toContain(announce);
  });

  it("follows a getter and a constructor assignment, and a subject created in the constructor", async () => {
    expect(await chained(`  private readonly changes = new Subject<string>();
  get changes$() { return this.changes.asObservable(); }`)).toContain(announce);
    expect(await chained(`  private changes!: Subject<string>;
  readonly changes$: Observable<string>;
  constructor() { this.changes = new Subject<string>(); this.changes$ = this.changes.asObservable(); }`)).toContain(announce);
  });

  it("follows a service that re-exposes another service's subject, and leaves a cycle alone", async () => {
    const facade = `import { Injectable, inject } from '@angular/core';
import { LeagueService } from './league.service';
@Injectable({ providedIn: 'root' })
export class FacadeService {
  private readonly league = inject(LeagueService);
  readonly changes$ = this.league.changes$;
}`;
    const listenerOnFacade = listener("Facade", "facade.service", "/api/facade");
    const links = new JsSubjectResolver()
      .resolve(await analyzeAll({ ...files, "src/facade.service.ts": facade, "src/facade-listener.component.ts": listenerOnFacade }))
      .map(show);
    expect(links).toContain("src/league.service.ts::LeagueService.announce -> src/facade-listener.component.ts::<pipe@9>");
    const cyc = await chained(`  readonly a$ = this.b$;
  readonly b$ = this.a$;
  readonly changes$ = this.a$;
  private readonly changes = new Subject<string>();`);
    expect(cyc.filter((l) => l.includes("club-detail"))).toEqual([]);
  });

  it("listens through a service injected into a local of the function", async () => {
    const links = new JsSubjectResolver()
      .resolve(
        await analyzeAll({
          ...files,
          "src/club-detail.component.ts": `import { Component, inject } from '@angular/core';
import { switchMap } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { LeagueService } from './league.service';
@Component({ selector: 'app-x', template: '' })
export class LeagueListenerComponent {
  private http = inject(HttpClient);
  ngOnInit() {
    const svc = inject(LeagueService);
    svc.changes$.pipe(switchMap(() => this.http.get('/api/matches'))).subscribe();
  }
}`,
        }),
      )
      .map(show);
    expect(links).toContain("src/league.service.ts::LeagueService.announce -> src/club-detail.component.ts::<pipe@10>");
  });

  it("leaves a local name two methods inject different services into alone", async () => {
    const links = new JsSubjectResolver()
      .resolve(
        await analyzeAll({
          ...files,
          "src/club-detail.component.ts": `import { Component, inject } from '@angular/core';
import { switchMap } from 'rxjs/operators';
import { LeagueService } from './league.service';
import { GarageService } from './garage.service';
@Component({ selector: 'app-x', template: '' })
export class MixedComponent {
  a() { const svc = inject(LeagueService); svc.changes$.pipe(switchMap(() => this.http.get('/api/a'))).subscribe(); }
  b() { const svc = inject(GarageService); svc.changes$.pipe(switchMap(() => this.http.get('/api/b'))).subscribe(); }
}`,
        }),
      )
      .map(show);
    expect(links.filter((l) => l.includes("MixedComponent") || l.includes("club-detail"))).toEqual([]);
  });

  it("leaves a subject of a service no listener holds, and a listener on a framework service, alone", async () => {
    const analyses = await analyzeAll({
      "src/league.service.ts": service("League"),
      "src/route-watch.component.ts": `import { Component } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
@Component({ selector: 'app-w', template: '' })
export class RouteWatchComponent {
  constructor(private route: ActivatedRoute, private clubs: ClubService) {
    this.route.params.subscribe(() => this.clubs.list());
  }
}`,
    });
    expect(new JsSubjectResolver().resolve(analyses)).toEqual([]);
    expect(analyses[1]!.subjectFlows?.listens).toBeUndefined();
  });
});
