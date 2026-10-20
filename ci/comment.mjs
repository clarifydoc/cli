// The pull-request comment of a CI run (ci/run.sh): the API surface diff, then
// the findings the change introduced, worst first. The first line is a marker
// the GitHub Action finds to edit its comment in place instead of adding one.
//
//   node ci/comment.mjs <head.sarif> <api.md> [base-sha] [gate 0|1]
import { readFileSync } from "node:fs";

const [sarifPath, apiPath, baseSha = "", gate = "0"] = process.argv.slice(2);
const MARKER = "<!-- clarifydoc-ci -->";
const SHOWN = 30;
const RANK = { error: 0, warning: 1, note: 2 };
const ICON = { error: "🔴", warning: "🟠", note: "⚪" };

const log = JSON.parse(readFileSync(sarifPath, "utf8"));
// The diff names its two analyses by their directories, which say nothing in a pull request.
const api = (apiPath ? safeRead(apiPath).trim() : "").replace(/^### API surface diff.*$/m, "### API surface");
const rows = [];
for (const run of log.runs ?? []) {
  const rules = run.tool?.driver?.rules ?? [];
  for (const r of run.results ?? []) {
    const loc = r.locations?.[0]?.physicalLocation;
    rows.push({
      level: r.level ?? "warning",
      isNew: r.baselineState !== "unchanged",
      rule: r.ruleId,
      title: rules[r.ruleIndex]?.shortDescription?.text ?? r.ruleId,
      where: loc ? `${decodeURI(loc.artifactLocation.uri)}:${loc.region?.startLine ?? 1}` : "",
      message: r.message?.text ?? "",
    });
  }
}
const fresh = rows.filter((r) => r.isNew).sort((a, b) => RANK[a.level] - RANK[b.level] || a.where.localeCompare(b.where));
const kept = rows.length - fresh.length;
const byLevel = (l) => fresh.filter((r) => r.level === l).length;

const out = [MARKER, "## ClarifyDoc", ""];
out.push(gate === "1" ? "❌ **A gate tripped** — see below." : "✅ No gate tripped.", "");
if (api) out.push(api, "");
const heading = baseSha ? `### Findings this change introduces` : `### Findings`;
out.push(heading, "");
if (fresh.length === 0) {
  out.push(baseSha ? `None${kept ? ` (${kept} finding${kept === 1 ? "" : "s"} already in the base)` : ""}.` : "None.");
} else {
  out.push(`${byLevel("error")} error · ${byLevel("warning")} warning · ${byLevel("note")} note${baseSha && kept ? ` · ${kept} already in the base` : ""}`, "");
  out.push("| | Rule | Where | Finding |", "|---|---|---|---|");
  for (const r of fresh.slice(0, SHOWN)) {
    out.push(`| ${ICON[r.level] ?? ""} | ${cell(r.title)} | \`${cell(r.where)}\` | ${cell(r.message)} |`);
  }
  if (fresh.length > SHOWN) out.push("", `…and ${fresh.length - SHOWN} more in the SARIF report.`);
}
if (baseSha) out.push("", `<sub>Compared with ${baseSha.slice(0, 12)}.</sub>`);
process.stdout.write(out.join("\n") + "\n");

function cell(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
function safeRead(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
