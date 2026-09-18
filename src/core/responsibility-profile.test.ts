import { describe, it, expect } from "vitest";
import { buildResponsibilityProfiles, classifyImportSource } from "./responsibility-profile.js";
import { createEmptyAnalysis, type DataSourceInfo, type FileAnalysis, type Language } from "../types/analysis.js";

const imp = (source: string, line = 1) => ({ source, specifiers: [], isDefault: false, isNamespace: false, isType: false, line });
const ds = (kind: DataSourceInfo["kind"], name: string, line: number, extra: Partial<DataSourceInfo> = {}): DataSourceInfo =>
  ({ kind, name, target: null, calls: [], line, ...extra });

function file(path: string, language: Language, mut: (a: FileAnalysis) => void): FileAnalysis {
  const a = createEmptyAnalysis(path, language);
  mut(a);
  return a;
}

describe("classifyImportSource", () => {
  it("classifies npm bare, scoped and deep imports through the plugin tables", () => {
    expect(classifyImportSource("axios")?.category).toBe("http");
    expect(classifyImportSource("@prisma/client")?.category).toBe("orm");
    expect(classifyImportSource("@prisma/client/runtime")?.category).toBe("orm");
    expect(classifyImportSource("winston/lib/transports")?.category).toBe("logging");
  });

  it("walks dotted namespace prefixes for .NET-style usings", () => {
    expect(classifyImportSource("Microsoft.EntityFrameworkCore")?.category).toBe("orm");
    expect(classifyImportSource("Microsoft.EntityFrameworkCore.Metadata.Builders")?.category).toBe("orm");
  });

  it("never classifies relative or alias imports", () => {
    expect(classifyImportSource("./db")).toBeUndefined();
    expect(classifyImportSource("@/services/api")).toBeUndefined();
    expect(classifyImportSource("../utils")).toBeUndefined();
  });
});

describe("buildResponsibilityProfiles", () => {
  it("omits files that touch no boundary", () => {
    const a = file("src/util/math.ts", "typescript", (f) => {
      f.imports.push(imp("./helpers"), imp("lodash"));
    });
    expect(buildResponsibilityProfiles([a])).toEqual([]);
  });

  it("derives boundaries, roles and effect flags from imports and data sources", () => {
    const a = file("src/orders/service.ts", "typescript", (f) => {
      f.imports.push(imp("@prisma/client", 1), imp("axios", 2), imp("amqplib", 3), imp("jsonwebtoken", 4), imp("pino", 5));
      f.dataSources.push(
        ds("database", "prisma.order.findMany", 20, { access: "read" }),
        ds("database", "prisma.order.update", 31, { access: "write" }),
        ds("api-call", "axios.post", 40),
        ds("queue-publish", "channel.publish", 52),
        ds("env", "process.env.DB_URL", 7),
      );
    });
    const [p] = buildResponsibilityProfiles([a]);
    expect(p.boundaries).toEqual(["auth", "config", "database", "http", "logging", "queue"]);
    expect(p.roles).toEqual(["configuration", "messaging", "observability", "persistence", "security", "transport"]);
    // logging + configuration are ubiquitous and do not count as mixed concerns
    expect(p.concernCount).toBe(4);
    expect(p.readsState).toBe(true);
    expect(p.writesState).toBe(true);
    expect(p.emitsEvents).toBe(true);
    expect(p.consumesEvents).toBe(false);
    expect(p.callsExternal).toBe(true);
    expect(p.servesRequests).toBe(false);
    expect(p.externalPackageCount).toBe(5);
    expect(p.evidence.map((e) => e.line)).toEqual([...p.evidence.map((e) => e.line)].sort((x, y) => x! - y!));
  });

  it("marks declared API routes as serving and frontend routes/screens as presentation", () => {
    const api = file("src/routes/users.ts", "typescript", (f) => {
      f.routes.push({ path: "/users", httpMethod: "GET", kind: "api", handler: "list", line: 3 } as any);
    });
    const ui = file("src/pages/Home.vue", "typescript", (f) => {
      f.routes.push({ path: "/home", httpMethod: null, kind: "frontend", handler: null, line: 1 } as any);
    });
    // Sorted by path: src/pages/… (ui) precedes src/routes/… (api).
    const [u, a] = buildResponsibilityProfiles([api, ui]).sort((x, y) => x.filePath.localeCompare(y.filePath));
    expect(u.roles).toEqual(["presentation"]);
    expect(a.roles).toEqual(["transport"]);
    expect(a.servesRequests).toBe(true);
    expect(a.evidence[0]).toMatchObject({ kind: "http", source: "route", operation: "serve", name: "GET /users" });
  });

  it("collapses several submodule imports of one package into one evidence row", () => {
    const a = file("src/db.ts", "typescript", (f) => {
      f.imports.push(imp("@prisma/client", 1), imp("@prisma/client/runtime", 2), imp("@prisma/client/extension", 3));
    });
    const [p] = buildResponsibilityProfiles([a]);
    expect(p.evidence).toHaveLength(1);
    expect(p.externalPackageCount).toBe(1);
  });

  it("sorts files with the most mixed concerns first", () => {
    const one = file("a.ts", "typescript", (f) => f.imports.push(imp("axios")));
    const two = file("b.ts", "typescript", (f) => f.imports.push(imp("axios"), imp("pg")));
    expect(buildResponsibilityProfiles([one, two]).map((p) => p.filePath)).toEqual(["b.ts", "a.ts"]);
  });
});
