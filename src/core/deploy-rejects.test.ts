import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DeployRejects } from "./deploy-rejects.js";
import { collectCloudFormation } from "./deployment-cloudformation.js";

const TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Resources:
  FixtureList:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: club-fixtures
      Handler: app.handler
      CodeUri: src/
`;

describe("DeployRejects", () => {
  let root: string;
  let out: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deploy-rejects-root-"));
    out = mkdtempSync(join(tmpdir(), "deploy-rejects-out-"));
    mkdirSync(join(root, "infra"));
    writeFileSync(join(root, "infra", "league.yml"), "title: Club league table\nrows: 20\n");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("skips a turned-down file while it is unchanged and reads it again once it changes", async () => {
    const first = await DeployRejects.open(root, out, true);
    expect(await collectCloudFormation(root, [], first)).toBeUndefined();
    await first.save();

    const second = await DeployRejects.open(root, out, true);
    expect(await second.readAll("cloudformation", ["infra/league.yml"])).toEqual([undefined]);

    writeFileSync(join(root, "infra", "league.yml"), TEMPLATE);
    const third = await DeployRejects.open(root, out, true);
    const found = await collectCloudFormation(root, [], third);
    expect(found?.groups.flat().map((s) => s.name)).toEqual(["club-fixtures"]);
  });

  it("reads a file again when only its modification time moved", async () => {
    const first = await DeployRejects.open(root, out, true);
    await collectCloudFormation(root, [], first);
    await first.save();
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "infra", "league.yml"), later, later);
    const second = await DeployRejects.open(root, out, true);
    expect((await second.readAll("cloudformation", ["infra/league.yml"]))[0]).toContain("Club league table");
  });

  it("ignores a cache written by another version or when the run does not reuse", async () => {
    const first = await DeployRejects.open(root, out, true);
    await collectCloudFormation(root, [], first);
    await first.save();
    const fresh = await DeployRejects.open(root, out, false);
    expect((await fresh.readAll("cloudformation", ["infra/league.yml"]))[0]).toContain("Club league table");
    writeFileSync(join(out, ".deploy-rejects.json"), JSON.stringify({ extractorVersion: "0.0.0", kinds: { cloudformation: { "infra/league.yml": [1, 1] } } }));
    const stale = await DeployRejects.open(root, out, true);
    expect((await stale.readAll("cloudformation", ["infra/league.yml"]))[0]).toContain("Club league table");
  });
});
