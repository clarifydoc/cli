import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Real-repo FP: 105 `jobRepository.queue` sites and 42 `emit`s cut route → service → job handler → repository. */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-server", dependencies: { "@nestjs/common": "10.0.0", "@nestjs/core": "10.0.0" } }),
  "src/enum.ts": "export enum JobName { MatchReport = 'match-report', TableRefresh = 'table-refresh', SquadPhoto = 'squad-photo' }\nexport enum QueueName { Reports = 'reports' }\n",
  "src/services/season.service.ts": `import { JobName } from '../enum';
export class SeasonService {
  constructor(private jobRepository: JobRepository) {}

  async close(ids: string[], refresh: boolean) {
    const jobs: JobItem[] = [{ name: JobName.MatchReport, data: {} }];
    if (refresh) {
      jobs.push({ name: JobName.TableRefresh });
    }
    await this.jobRepository.queueAll(jobs);
    await this.jobRepository.queueAll(ids.map((id) => ({ name: JobName.SquadPhoto, data: { id } })));
  }
}
`,
  "src/services/match.service.ts": `import { JobName } from '../enum';
export class MatchService {
  constructor(private jobRepository: JobRepository, private eventRepository: EventRepository) {}

  async finish(id: string) {
    await this.jobRepository.queue({ name: JobName.MatchReport, data: { id } });
    this.eventRepository.emit('MatchFinished', { id });
  }
}
`,
  "src/services/report.service.ts": `import { JobName, QueueName } from '../enum';
export class ReportService {
  @OnJob({ name: JobName.MatchReport, queue: QueueName.Reports })
  async handleMatchReport({ id }: { id: string }) {
    return this.reportRepository.create(id);
  }

  @OnEvent({ name: 'MatchFinished' })
  async onMatchFinished({ id }: { id: string }) {}
}
`,
  "src/services/table.service.ts": `export class TableService {
  @OnEvent('MatchFinished')
  async recompute() {}

  @OnJob({ name: JobName.TableRefresh, queue: QueueName.Reports })
  async handleTableRefresh() {}

  @OnJob({ name: JobName.SquadPhoto, queue: QueueName.Reports })
  async handleSquadPhoto() {}
}
`,
};

describe("jobs and events joined by name", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-job-events-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links the queueing method to the job's handler and the emitter to every listener", () => {
    const links = summary.symbolLinks
      .filter((l) => l.sourceSymbol === "MatchService.finish" && /^(?:job|event):/.test(l.callName))
      .map((l) => `${l.callName} → ${l.targetSymbol}`)
      .sort();
    expect(links).toEqual([
      "event:MatchFinished → ReportService.onMatchFinished",
      "event:MatchFinished → TableService.recompute",
      "job:JobName.MatchReport → ReportService.handleMatchReport",
    ]);
  });

  it("links queueAll to the handler of every job its list holds — built in the function, or mapped (real-repo FP)", () => {
    const links = summary.symbolLinks
      .filter((l) => l.sourceSymbol === "SeasonService.close" && /^job:/.test(l.callName))
      .map((l) => `${l.sourceLine} ${l.callName} → ${l.targetSymbol}`)
      .sort();
    expect(links).toEqual([
      "10 job:JobName.MatchReport → ReportService.handleMatchReport",
      "10 job:JobName.TableRefresh → TableService.handleTableRefresh",
      "11 job:JobName.SquadPhoto → TableService.handleSquadPhoto",
    ]);
  });
});
