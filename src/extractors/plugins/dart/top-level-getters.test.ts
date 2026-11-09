import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { SymbolLink } from "../../../types/analysis.js";
import "./meta.js";

/**
 * A Dart top-level getter is a typed name every library importing it sees: `GarageGateway get garageGateway`
 * types `garageGateway.renewLease(id)` in another file, through the library's `part`s and a barrel's `export`,
 * never through a library the caller does not import (a namesake getter of another type).
 */
const gateway = (name: string, verb: string, path: string, extra = "") => `class ${name} {
  final Dio _dio;
  ${name}(this._dio);

  Future<void> renewLease(int id) async {
    await _dio.${verb}("${path}", data: {"id": id});
  }
${extra}}
`;

const FILES: Record<string, string> = {
  "pubspec.yaml": "name: garage\ndependencies:\n  dio: ^5.0.0\n",
  "lib/gateways/garage_gateway.dart": `import 'package:dio/dio.dart';

${gateway("GarageGateway", "put", "/garages/lease")}
${gateway("PitGateway", "post", "/pits/lease")}
${gateway("TicketGateway", "patch", "/tickets/lease")}`,
  "lib/gateways/club_gateway.dart": `import 'package:dio/dio.dart';

${gateway("ClubGateway", "delete", "/clubs/lease")}`,
  // The one other class declaring `closeBay`: a name guess would land here.
  "lib/workshop.dart": "class Workshop {\n  void closeBay() {}\n}\n",
  "lib/service_locator.dart": `import 'package:dio/dio.dart';
import 'package:garage/gateways/garage_gateway.dart';
import 'package:garage/gateways/club_gateway.dart';

part 'service_locator_parts.dart';

class ServiceLocator {
  static final ServiceLocator instance = ServiceLocator._();
  ServiceLocator._();
  late Dio dio;
}

GarageGateway? _garageGateway;
GarageGateway get garageGateway {
  _garageGateway ??= GarageGateway(ServiceLocator.instance.dio);
  return _garageGateway!;
}

ClubGateway get clubGateway => ClubGateway(ServiceLocator.instance.dio);

late final TicketGateway ticketGateway;
`,
  "lib/service_locator_parts.dart": `part of 'service_locator.dart';

PitGateway get pitGateway => PitGateway(ServiceLocator.instance.dio);
`,
  "lib/locators.dart": "export 'service_locator.dart' show clubGateway;\n",
  // A namesake getter of another type, in a library the garage service does not import.
  "lib/fleet/fleet_locator.dart": `import 'package:dio/dio.dart';

${gateway("CarGateway", "put", "/cars/lease")}
CarGateway get garageGateway => CarGateway(Dio());
`,
  "lib/services/garage_service.dart": `import 'package:garage/service_locator.dart';
import 'package:garage/workshop.dart';

class GarageService {
  Future<void> renewGarage(int id) async {
    await garageGateway.renewLease(id);
  }

  Future<void> renewClub(int id) async {
    await clubGateway.renewLease(id);
  }

  Future<void> renewPit(int id) async {
    await pitGateway.renewLease(id);
  }

  Future<void> renewTicket(int id) async {
    await ticketGateway.renewLease(id);
  }

  void closeGarage() {
    garageGateway.closeBay();
    Workshop().closeBay();
  }
}
`,
  "lib/services/club_desk.dart": `import 'package:garage/locators.dart';

class ClubDesk {
  Future<void> renew(int id) async {
    await clubGateway.renewLease(id);
  }

  Future<void> renewGarage(int id) async {
    await garageGateway.renewLease(id);
  }
}
`,
  "lib/fleet/fleet_service.dart": `import 'package:garage/fleet/fleet_locator.dart';

class FleetService {
  Future<void> renewCar(int id) async {
    await garageGateway.renewLease(id);
  }
}
`,
};

describe("Dart top-level getters", () => {
  let dir: string;
  let links: SymbolLink[];
  const targetsOf = (source: string, call: string) =>
    links.filter((l) => l.sourceSymbol === source && l.callName === call && l.relation !== "reference").map((l) => `${l.targetFile}::${l.targetSymbol}`);
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-dart-getters-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    links = (await loadReportSummary(join(dir, "out"))).symbolLinks;
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types a call through a getter of the imported library, never the namesake of a library not imported", () => {
    expect(targetsOf("GarageService.renewGarage", "garageGateway.renewLease")).toEqual(["lib/gateways/garage_gateway.dart::GarageGateway.renewLease"]);
    expect(targetsOf("GarageService.renewClub", "clubGateway.renewLease")).toEqual(["lib/gateways/club_gateway.dart::ClubGateway.renewLease"]);
    expect(targetsOf("FleetService.renewCar", "garageGateway.renewLease")).toEqual(["lib/fleet/fleet_locator.dart::CarGateway.renewLease"]);
  });

  it("reads a getter declared in a part of the library, and a top-level late variable", () => {
    expect(targetsOf("GarageService.renewPit", "pitGateway.renewLease")).toEqual(["lib/gateways/garage_gateway.dart::PitGateway.renewLease"]);
    expect(targetsOf("GarageService.renewTicket", "ticketGateway.renewLease")).toEqual(["lib/gateways/garage_gateway.dart::TicketGateway.renewLease"]);
  });

  it("follows a barrel's export, only the names it shows", () => {
    expect(targetsOf("ClubDesk.renew", "clubGateway.renewLease")).toEqual(["lib/gateways/club_gateway.dart::ClubGateway.renewLease"]);
    expect(targetsOf("ClubDesk.renewGarage", "garageGateway.renewLease")).not.toContain("lib/gateways/garage_gateway.dart::GarageGateway.renewLease");
  });

  it("refuses a name guess onto another class's member the getter's type lacks", () => {
    expect(targetsOf("GarageService.closeGarage", "garageGateway.closeBay")).toEqual([]);
  });
});
