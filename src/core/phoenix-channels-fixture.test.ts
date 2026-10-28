import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** A Phoenix channel and its `phoenix` JS client: the screen → channel → table chain across the socket. */
const FILES: Record<string, string> = {
  "mix.exs": `defmodule League.MixProject do
  use Mix.Project
  def project, do: [app: :league, deps: [{:phoenix, "~> 1.7"}]]
end
`,
  "lib/league_web/channels/user_socket.ex": `defmodule LeagueWeb.UserSocket do
  use Phoenix.Socket
  channel "match:*", LeagueWeb.MatchChannel
end
`,
  "lib/league_web/channels/match_channel.ex": `defmodule LeagueWeb.MatchChannel do
  use Phoenix.Channel
  def join("match:" <> _id, _payload, socket), do: {:ok, socket}

  def handle_in("new_goal", payload, socket) do
    League.Repo.insert!(%League.Goal{minute: payload["minute"]})
    broadcast!(socket, "goal_scored", payload)
    {:noreply, socket}
  end

  def handle_in("substitute", payload, socket) do
    League.Repo.insert!(%League.Substitution{minute: payload["minute"]})
    {:noreply, socket}
  end
end
`,
  "assets/js/match.js": `import { Socket } from "phoenix";
const socket = new Socket("/socket", {});
export function scoreGoal(id, minute) {
  const channel = socket.channel(\`match:\${id}\`, {});
  channel.join();
  channel.push("new_goal", { minute });
  channel.on("goal_scored", (p) => console.log(p));
}
`,
};

describe("Phoenix channels across the socket", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-phx-channel-"));
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

  it("gives each handle_in clause its own event and the data it writes", () => {
    const rows = (summary.symbolDataAccess ?? []).filter((r) => r.file.endsWith("match_channel.ex"))
      .map((r) => `${r.symbol} ${r.access ?? "db"} ${r.entity}`).sort();
    expect(rows).toEqual([
      'LeagueWeb.MatchChannel.handle_in("new_goal") db Goal',
      'LeagueWeb.MatchChannel.handle_in("new_goal") queue-consume new_goal',
      'LeagueWeb.MatchChannel.handle_in("new_goal") queue-publish goal_scored',
      'LeagueWeb.MatchChannel.handle_in("substitute") db Substitution',
      'LeagueWeb.MatchChannel.handle_in("substitute") queue-consume substitute',
    ]);
  });

  it("joins the client's push to the clause that handles it, and the broadcast back to the client's listener", () => {
    const hops = summary.symbolLinks.filter((l) => l.strategy === "queue")
      .map((l) => `${l.sourceSymbol} → ${l.targetSymbol} (${l.callName})`).sort();
    expect(hops).toEqual([
      'LeagueWeb.MatchChannel.handle_in("new_goal") → scoreGoal (MQ goal_scored)',
      'scoreGoal → LeagueWeb.MatchChannel.handle_in("new_goal") (MQ new_goal)',
    ]);
  });
});
