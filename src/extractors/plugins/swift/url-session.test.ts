import { describe, expect, it } from "vitest";
import { extractSwiftDataSources } from "./data-sources.js";

const calls = (src: string) => extractSwiftDataSources(src.split("\n")).filter((d) => d.kind === "api-call");

describe("Swift URLSession requests", () => {
  it("follows a URLRequest local to its URL and httpMethod", () => {
    const found = calls(`import Foundation
func a() {
  let url = URL(string: "https://league.example.com/api/clubs")!
  var req = URLRequest(url: url)
  req.httpMethod = "POST"
  URLSession.shared.dataTask(with: req) { _,_,_ in }.resume()
  let u2 = URL(string: "https://league.example.com/api/players/\\(id)")!
  let (data, _) = try await URLSession.shared.data(from: u2)
}`);
    expect(found.map((d) => [d.name, d.target])).toEqual([["POST", "https://league.example.com/api/clubs"], ["GET", "https://league.example.com/api/players/${id}"]]);
  });
  it("keeps the row without a target when the URL is not stated", () => {
    expect(calls(`import Foundation\nfunc a(req: URLRequest) { URLSession.shared.dataTask(with: req) { _,_,_ in } }`)).toMatchObject([{ name: "URLSession", target: null }]);
  });
});
