import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import "./meta.js";

/**
 * A top-level getter is a function of its own: the calls and constructions in a lazy service locator
 * (`GarageGateway get garageGateway { _g ??= GarageGateway(dio); … }`, `=> PitGateway(dio)`) belong to it, so the
 * getter reaches what it builds (real-repo FP: ~45 locator getters recorded no function). A getter of a class and of
 * another library of the same name keep their own bodies.
 */
const FILES: Record<string, string> = {
  "pubspec.yaml": "name: garage\ndependencies:\n  dio: ^5.0.0\n",
  "lib/gateways.dart": `import 'package:dio/dio.dart';

class GarageGateway {
  GarageGateway(this.dio);
  final Dio dio;
}

class PitGateway {
  PitGateway(this.dio);
  final Dio dio;
}

class CarGateway {
  CarGateway(this.dio);
  final Dio dio;
}
`,
  "lib/locator.dart": `import 'package:dio/dio.dart';
import 'package:garage/gateways.dart';

GarageGateway? _garageGateway;
GarageGateway get garageGateway {
  _garageGateway ??= GarageGateway(Dio());
  return _garageGateway!;
}

PitGateway get pitGateway => PitGateway(Dio());

class Workshop {
  CarGateway get cars => CarGateway(Dio());
}
`,
  "lib/fleet_locator.dart": `import 'package:dio/dio.dart';
import 'package:garage/gateways.dart';

CarGateway get garageGateway => CarGateway(Dio());
`,
};

describe.each([["tree-sitter", undefined], ["regex", "no-tree-sitter:dart"]])("Dart top-level getters as functions (%s front end)", (_name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-dart-getter-fns-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    if (saved === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const reaches = (file: string, from: string) =>
    summary.symbolLinks.filter((l) => l.sourceFile === file && l.sourceSymbol === from && l.relation !== "reference").map((l) => `${l.callName}->${l.targetFile}::${l.targetSymbol}`);

  it("records the getter with the calls and constructions of its block or arrow body", async () => {
    expect(reaches("lib/locator.dart", "garageGateway")).toContain("GarageGateway->lib/gateways.dart::GarageGateway.GarageGateway");
    expect(reaches("lib/locator.dart", "pitGateway")).toContain("PitGateway->lib/gateways.dart::PitGateway.PitGateway");
  });

  it("keeps a namesake getter of another library on its own construction", () => {
    expect(reaches("lib/fleet_locator.dart", "garageGateway")).toContain("CarGateway->lib/gateways.dart::CarGateway.CarGateway");
    expect(reaches("lib/fleet_locator.dart", "garageGateway")).not.toContain("GarageGateway->lib/gateways.dart::GarageGateway.GarageGateway");
    expect(reaches("lib/locator.dart", "garageGateway")).not.toContain("CarGateway->lib/gateways.dart::CarGateway.CarGateway");
  });

  it("leaves a class's getter to its class", () => {
    expect(reaches("lib/locator.dart", "cars")).toEqual([]);
  });
});
