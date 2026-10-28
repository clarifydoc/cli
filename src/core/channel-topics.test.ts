import { describe, it, expect } from "vitest";
import type { DataSourceInfo, FileAnalysis } from "../types/analysis.js";
import { scopeChannelTopics } from "./channel-topics.js";

const row = (kind: "queue-publish" | "queue-consume", target: string, line: number, topic?: string): DataSourceInfo =>
  ({ kind, name: "Phoenix.Channel", target, calls: [], line, ...(topic ? { topic } : {}) });
const file = (filePath: string, dataSources: DataSourceInfo[]): FileAnalysis => ({ filePath, dataSources } as unknown as FileAnalysis);
const targets = (files: FileAnalysis[]): string[] => files.flatMap((f) => f.dataSources.map((d) => `${f.filePath}:${d.line} ${d.target}`));

describe("scopeChannelTopics", () => {
  it("keeps one event apart on topics that cannot meet, a literal topic taking the pattern it falls under", () => {
    const files = [
      file("match_channel.ex", [row("queue-consume", "new_goal", 4, "match:*")]),
      file("lobby_channel.ex", [row("queue-consume", "new_goal", 4, "lobby")]),
      file("match.js", [row("queue-publish", "new_goal", 6, "match:1")]),
    ];
    expect(scopeChannelTopics(files)).toBe(3);
    expect(targets(files)).toEqual([
      "match_channel.ex:4 new_goal@match:*",
      "lobby_channel.ex:4 new_goal@lobby",
      "match.js:6 new_goal@match:*",
    ]);
  });

  it("repeats a row without a topic for every topic, so it still meets them all", () => {
    const files = [
      file("match_channel.ex", [row("queue-consume", "new_goal", 4, "match:*")]),
      file("lobby_channel.ex", [row("queue-consume", "new_goal", 4, "lobby")]),
      file("board.js", [row("queue-publish", "new_goal", 2)]),
    ];
    scopeChannelTopics(files);
    expect(targets(files).sort()).toEqual([
      "board.js:2 new_goal@lobby",
      "board.js:2 new_goal@match:*",
      "lobby_channel.ex:4 new_goal@lobby",
      "match_channel.ex:4 new_goal@match:*",
    ]);
  });

  it("leaves an event alone when its rows state one topic or none", () => {
    const files = [
      file("match_channel.ex", [row("queue-consume", "new_goal", 4, "match:*"), row("queue-consume", "kickoff", 5)]),
      file("match.js", [row("queue-publish", "new_goal", 6, "match:9"), row("queue-publish", "kickoff", 7)]),
    ];
    expect(scopeChannelTopics(files)).toBe(0);
    expect(targets(files)).toEqual(["match_channel.ex:4 new_goal", "match_channel.ex:5 kickoff", "match.js:6 new_goal", "match.js:7 kickoff"]);
  });
});
