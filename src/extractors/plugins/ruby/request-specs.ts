import type { DataSourceInfo } from "../../../types/analysis.js";

/**
 * A request spec or integration test requests the app in-process by path —
 *
 *   post "/league/clubs/#{club.id}/transfers", params: { fee: 3 }, as: :json
 *   expect { delete "/league/clubs/#{club.id}" }.to change(Club, :count)
 *
 * — and the request runs the route's action. Each such request is an `api-call` at that path, so
 * the route linker joins it to the route (a test's link) and test reach goes on to the action.
 * Only in a test: an RSpec file (a top-level group) or a Rails integration / controller test; a
 * path is a string starting with `/` (a controller spec's `get :index` names no path), and a
 * statement that opens a block or names a target (`get "/x" do`, `get "/x", to: …`) is a route.
 */

/** An RSpec group at the top level, or a Rails test class that requests by path. */
const TEST_FILE = /^\s*(?:RSpec\s*\.\s*)?(?:describe|context|feature)\b|<\s*(?:ActionDispatch::IntegrationTest|ActionController::TestCase)\b/m;

/** `get "/path"` at a statement's start, or first in a block or parentheses (`expect { post "/x" }`). */
const REQUEST = /(?:^|[{(;]|\bdo)\s*(get|post|put|patch|delete|head)\s*\(?\s*(["'])(\/(?:[^"'\\]|\\.)*)\2/g;

export function extractRubyTestRequests(lines: readonly string[]): DataSourceInfo[] {
  if (!TEST_FILE.test(lines.join("\n"))) return [];
  const out: DataSourceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("#") || !/\b(?:get|post|put|patch|delete|head)\b/.test(line)) continue;
    for (const m of line.matchAll(REQUEST)) {
      const rest = line.slice(m.index! + m[0].length);
      if (/^\s*(?:,\s*to:|=>|,\s*:to\b)|\bdo\s*(?:\|[^|]*\|)?\s*$/.test(rest)) continue;
      out.push({ kind: "api-call", name: m[1]!, target: m[3]!, calls: [], line: i + 1 });
    }
  }
  return out;
}
