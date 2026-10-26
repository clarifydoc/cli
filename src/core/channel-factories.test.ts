import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** Real-repo FP: a server emitting every websocket event through one wrapper — the event is the wrapper's parameter. */
const FILES: Record<string, string> = {
  "package.json": `{ "name": "league", "dependencies": { "socket.io": "4.7.0", "socket.io-client": "4.7.0" } }\n`,
  "server/src/repositories/websocket.repository.ts": `import { Server, Socket } from 'socket.io';

export class WebsocketRepository {
  server?: Server;

  clientSend(event: string, room: string, ...data: unknown[]) {
    this.server?.to(room).emit(event, ...data);
  }

  clientBroadcast(event: string, ...data: unknown[]) {
    this.server?.emit(event, ...data);
  }
}
`,
  "server/src/services/match.service.ts": `import { WebsocketRepository } from '../repositories/websocket.repository';

export class MatchService {
  constructor(private websocketRepository: WebsocketRepository) {}

  finish(clubId: string, match: unknown) {
    this.websocketRepository.clientSend('on_match_finished', clubId, match);
  }

  announce(name: string) {
    this.websocketRepository.clientBroadcast('on_league_news', name);
    this.websocketRepository.clientSend(name, name);
  }
}
`,
  "web/src/websocket.ts": `import { io } from 'socket.io-client';

const websocket = io('', { path: '/api/socket.io' });

export function listen(onFinished: (m: unknown) => void) {
  websocket.on('on_match_finished', onFinished).on('on_league_news', () => undefined);
}
`,
};

describe("a wrapper emitting the event its caller names", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-channel-"));
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

  it("publishes at each call site on the literal it hands the wrapper", () => {
    const rows = (summary.symbolDataAccess ?? []).filter((r) => r.access === "queue-publish")
      .map((r) => `${r.symbol} ${r.entity}`).sort();
    expect(rows).toEqual(["MatchService.announce on_league_news", "MatchService.finish on_match_finished"]);
  });

  it("joins the call site to the listeners of that event", () => {
    const hops = summary.symbolLinks.filter((l) => l.targetFile === "web/src/websocket.ts")
      .map((l) => `${l.sourceSymbol} → ${l.targetSymbol}`).sort();
    expect(hops).toEqual(["MatchService.announce → listen", "MatchService.finish → listen"]);
  });
});
