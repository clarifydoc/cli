import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A Rails view whose POST form names no URL posts to the page's own address: the GET route of the action
 * that renders it implicitly. Decoys: an action that may render another page, a view two routes serve.
 */
const files: Record<string, string> = {
  "config/routes.rb": `Rails.application.routes.draw do
  get "/clubs/join", to: "clubs#join"
  post "/clubs/join", to: "clubs#create_join"
  get "/clubs/scout", to: "clubs#scout"
  post "/clubs/scout", to: "clubs#create_scout"
  get "/clubs/vote", to: "clubs#vote"
  post "/clubs/vote", to: "clubs#create_vote"
  get "/first", to: "clubs#shared"
  get "/second", to: "clubs#shared"
  post "/first", to: "clubs#create_shared"
end
`,
  "app/controllers/clubs_controller.rb": `class ClubsController < ApplicationController
  def join
  end

  def create_join
    Club.create!(name: params[:name])
    redirect_to "/clubs/join"
  end

  def scout
  end

  def create_scout
    Player.create!(name: params[:name])
    redirect_to "/clubs/scout"
  end

  def vote
    redirect_to "/clubs/join" if params[:closed]
  end

  def create_vote
    Match.create!(name: params[:name])
    redirect_to "/clubs/vote"
  end

  def shared
  end

  def create_shared
    Club.create!(name: params[:name])
    redirect_to "/first"
  end
end
`,
  "app/views/clubs/join.html.erb": `<h1>Join</h1>\n<%= form_with scope: :club do |f| %>\n  <%= f.text_field :name %>\n  <%= f.submit "Join" %>\n<% end %>\n`,
  "app/views/clubs/scout.html.erb": `<h1>Scout</h1>\n<form method="post">\n  <input name="name">\n  <button type="submit">Scout</button>\n</form>\n`,
  "app/views/clubs/vote.html.erb": `<h1>Vote</h1>\n<%= form_tag do %>\n  <%= submit_tag "Vote" %>\n<% end %>\n`,
  "app/views/clubs/shared.html.erb": `<h1>Shared</h1>\n<%= form_tag do %>\n  <%= submit_tag "Save" %>\n<% end %>\n`,
};

describe("a Rails POST form with no URL", () => {
  let dir: string;
  let links: string[];
  let flow: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-rails-ownview-"));
    const root = join(dir, "app");
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const out = join(dir, "out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    const s = await loadReportSummary(out);
    links = (s.apiRouteLinks ?? []).map((l) => `${l.method} ${l.routePath ?? l.url}`).sort();
    flow = (s.screenFlow?.edges ?? []).filter((e) => e.kind === "submit").map((e) => `${e.from} > ${e.to} ${e.via}`).sort();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("posts to the route of the action that renders its view implicitly", () => {
    expect(links).toContain("POST /clubs/join");
    expect(links).toContain("POST /clubs/scout");
    expect(flow).toContain("app/views/clubs/join.html.erb > app/views/clubs/join.html.erb POST /clubs/join");
  });

  it("leaves an action that renders explicitly, and a view two routes serve, alone", () => {
    expect(links.some((l) => l.includes("/clubs/vote") || l.includes("/first"))).toBe(false);
  });
});
