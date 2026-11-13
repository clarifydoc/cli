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
