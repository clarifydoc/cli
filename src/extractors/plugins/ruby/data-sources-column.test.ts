import { describe, it, expect } from "vitest";
import { extractRubyHttpCalls } from "./index.js";
import { extractRubyTestRequests } from "./request-specs.js";

describe("Ruby api calls carry a column", () => {
  it("points an outbound call and a request spec at their start, after a non-ASCII prefix too", () => {
    const calls = extractRubyHttpCalls([
      "def load",
      '  RestClient.get "https://clubs.example/api/clubs"',
      '  s = "é🚗"; HTTParty.post("https://clubs.example/api/players")',
      "end",
    ]);
    expect(calls.map((d) => [d.name, d.line, d.column])).toEqual([["get", 2, 2], ["post", 3, 13]]);
    const specs = extractRubyTestRequests([
      'RSpec.describe "Clubs" do',
      '  it "lists" do',
      '    get "/api/clubs"',
      '    expect { post "/api/players" }.to change(Player, :count)',
      "  end",
      "end",
    ]);
    expect(specs.map((d) => [d.name, d.line, d.column])).toEqual([["get", 3, 4], ["post", 4, 13]]);
  });
});
