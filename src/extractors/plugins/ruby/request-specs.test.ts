import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { fileTestVerdict } from "../../../core/test-functions.js";
import type { FileAnalysis, ProjectAnalysis } from "../../../types/analysis.js";
import { extractRubyTestRequests } from "./request-specs.js";

describe("Ruby test requests", () => {
  it("reads a request spec's requests by path, never a route or a controller spec's action", () => {
    const rows = extractRubyTestRequests(
      [
        "RSpec.describe 'League clubs', type: :request do",
        "  it 'shows' do",
        "    get '/league/clubs'",
        "    expect { post \"/league/clubs/#{club.id}/transfer\", as: :json }.to change(Transfer, :count)",
        "    delete(\"/league/clubs/#{club.id}\")",
        "    get :index",
        "    # get '/commented'",
        "    client.get('/not/a/test/request')",
        "  end",
        "end",
      ],
    );
    expect(rows.map((r) => `${r.name} ${r.target} @${r.line}`)).toEqual([
      "get /league/clubs @3",
      "post /league/clubs/#{club.id}/transfer @4",
      "delete /league/clubs/#{club.id} @5",
    ]);
    // A routes file or a Sinatra app declares routes; nothing there is a request.
    expect(extractRubyTestRequests(["Rails.application.routes.draw do", "  get '/clubs', to: 'clubs#index'", "end"])).toEqual([]);
    expect(extractRubyTestRequests(["describe 'x' do", "  get '/clubs' do", "  end", "end"])).toEqual([]);
  });
});

/** A request spec's request runs the action, and what the action calls (real-repo FP). */
const FILES: Record<string, string> = {
  "Gemfile": `gem "rails"\ngem "rspec-rails"\n`,
  "config/routes.rb": `Rails.application.routes.draw do
  post "/league/clubs/:id/transfer", to: "league/clubs#transfer"
  get "/league/clubs/:id/scouting", to: "league/clubs#scouting"
end
`,
  "app/controllers/league/clubs_controller.rb": `class League::ClubsController < ApplicationController
  def transfer
    TransferLogger.log('transfer')
    head :ok
  end

  def scouting
    ScoutLogger.log('scouting')
    head :ok
  end
end
`,
  "app/services/transfer_logger.rb": `class TransferLogger
  def self.log(event)
    event
  end
end
`,
  "app/services/scout_logger.rb": `class ScoutLogger
  def self.log(event)
    event
  end
end
`,
  "spec/requests/league/clubs_spec.rb": `require 'rails_helper'

RSpec.describe 'League clubs', type: :request do
  let(:club) { create(:club) }

  describe 'POST /league/clubs/:id/transfer' do
    it 'logs the transfer' do
      expect { post "/league/clubs/#{club.id}/transfer", as: :json }.not_to raise_error
    end
  end
end
`,
};

describe("a request spec reaches the action it requests", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-request-specs-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links the request to the route as a test's", () => {
    const links = (summary.apiRouteLinks ?? []).filter((l) => l.source === "spec/requests/league/clubs_spec.rb");
    expect(links.map((l) => `${l.method} ${l.routePath} ${l.sourceRole}`)).toEqual(["POST /league/clubs/:id/transfer test"]);
  });

  it("calls what the requested action runs tested, and the other action's untested", async () => {
    const file = async (path: string) => JSON.parse(await readFile(join(dir, "out", `${path}.json`), "utf-8")) as FileAnalysis;
    const verdict = async (path: string) => fileTestVerdict(summary, path, await file(path));
    const tested = await verdict("app/services/transfer_logger.rb");
    expect(tested.state).toBe("tested");
    // The route runs its action's calls as its own.
    expect([...tested.reach.values()][0]!.via).toEqual(["route:POST /league/clubs/:id/transfer"]);
    expect((await verdict("app/services/scout_logger.rb")).state).toBe("untested");
  });
});
