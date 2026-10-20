import { describe, it, expect } from "vitest";
import { join, resolve } from "path";
import { loadReportSummary } from "../core/report-payload.js";
import { askFromIssue } from "./ask.js";
import { issueSubjects } from "./issue-subjects.js";

const analysisDir = resolve("test-output/sample-backend");
const ISSUE = `Registering fails with a 500

Calling POST /api/auth/register with a new email returns 500. Trace:

    Error: duplicate key
        at createUser (services/userService.ts:12:9)
        at register (controllers/authController.ts:13:22)

It started after the change to \`hashPassword\` in authService.ts. Also seen on /api/users/42.
Nothing to do with PaymentGateway.charge, which we do not have.`;

describe("issueSubjects", () => {
  it("reads a stack frame, a route, a file, a code span and a path the route map has — and nothing the analysis lacks", async () => {
    const summary = await loadReportSummary(analysisDir);
    const subjects = issueSubjects(ISSUE, summary, 10);
    const rows = subjects.map((s) => `${s.kind} ${s.subject}${s.file ? ` @${s.file}` : ""}`);
    // The stack frames come first: they name the code that ran.
    expect(rows.slice(0, 2)).toEqual(["symbol createUser @services/userService.ts", "symbol register @controllers/authController.ts"]);
    expect(rows).toContain("route POST /api/auth/register");
    expect(rows).toContain("file services/authService.ts");
    expect(rows).toContain("symbol hashPassword");
    expect(rows.some((r) => r.startsWith("route ") && r.includes("/api/users/"))).toBe(true);
    expect(rows.join("\n")).not.toContain("PaymentGateway");
    expect(subjects[0]!.why).toMatch(/^a stack frame: at createUser/);
  });

  it("explains the likeliest subjects after listing what the issue was read as", async () => {
    const config = { projectRoot: resolve("test-fixtures/sample-backend"), analysisDir, allowAnalyze: false, allowColdStart: false };
    const r = await askFromIssue(config, ISSUE, { explain: 2, maxTokens: 4000 });
    expect(r.text).toMatch(/^# From the issue: \d+ subjects\n\n1\. symbol createUser \(services\/userService\.ts\) — a stack frame/);
    expect(r.text).toMatch(/\n## createUser \(services\/userService\.ts\)\n/);
    expect(r.text).toMatch(/\n### Source\n/);
    const none = await askFromIssue(config, "The colours on the settings page look off.");
    expect(none.text).toMatch(/^# Nothing in the issue names a route, file or function the analysis knows/);
  });
});
