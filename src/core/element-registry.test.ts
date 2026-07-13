import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import fg from "fast-glob";
import {
  normalizeProject,
  denormalizeProject,
  normalizeFileAnalysis,
  denormalizeFileAnalysis,
} from "./element-registry.js";

/**
 * Round-trip safety net for the element-registry codec.
 *
 * Each `test-output/**` fixture is a real artifact in the *denormalized*
 * (in-memory) shape. The invariant we guard is: normalizing then denormalizing
 * any in-memory artifact reproduces it byte-for-byte (modulo object key order).
 * Under Phase 0 identity stubs this holds trivially; from Phase 1 on it is the
 * primary regression gate for the codec.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");

/** Recursively sort object keys so deep-equality ignores key order (arrays keep order). */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stable((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function load(relPath: string): unknown {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), "utf-8"));
}

// Cover every language/framework sample once; skip the all-fixtures mirror
// (pure duplication) to keep the suite fast.
const PROJECT_SUMMARIES = fg.sync("test-output/**/project-summary.json", {
  cwd: REPO_ROOT,
  ignore: ["test-output/all-fixtures/**"],
});

const PER_FILE = fg.sync("test-output/**/*.json", {
  cwd: REPO_ROOT,
  ignore: [
    "test-output/all-fixtures/**",
    "**/project-summary.json",
    "**/lsp-*.json",
  ],
});

describe("element-registry codec round-trips project summaries", () => {
  it("found fixtures to test", () => {
    expect(PROJECT_SUMMARIES.length).toBeGreaterThan(0);
    expect(PER_FILE.length).toBeGreaterThan(0);
  });

  for (const rel of PROJECT_SUMMARIES) {
    it(`round-trips ${rel}`, () => {
      // Denormalize on load so the test is format-agnostic: the reference is the
      // in-memory shape whether the fixture on disk is old- or new-format.
      const original = denormalizeProject(load(rel));
      const roundTripped = denormalizeProject(normalizeProject(original));
      expect(stable(roundTripped)).toEqual(stable(original));
    });
  }
});

describe("element-registry codec round-trips per-file analyses", () => {
  for (const rel of PER_FILE) {
    it(`round-trips ${rel}`, () => {
      const original = denormalizeFileAnalysis(load(rel));
      const roundTripped = denormalizeFileAnalysis(normalizeFileAnalysis(original));
      expect(stable(roundTripped)).toEqual(stable(original));
    });
  }
});

/**
 * Synthetic edge cases that the real fixtures do not exercise — guards against
 * the reversibility traps surfaced by adversarial fuzzing: `::`-in-id segments
 * (Perl/C++ symbols, namespaced datastore targets), externals, file nodes,
 * tri-state optionals, and isInterface=false declarations.
 */
function baseProject(): any {
  return {
    projectRoot: "/p",
    detectedFrameworks: [],
    subProjects: [],
    fileProjects: {},
    files: [],
    componentGraph: {},
    linkGraph: [],
    interactiveElements: [],
    events: [],
    routeMap: [],
    apiCalls: [],
    screens: [],
    symbolLinks: [],
    analyzedAt: "2026-06-16T00:00:00.000Z",
  };
}

function roundTrips(p: unknown): void {
  expect(stable(denormalizeProject(normalizeProject(p as any)))).toEqual(stable(p));
}

describe("element-registry codec — synthetic edge cases", () => {
  it("dataAccess entity/datastore targets containing '::'", () => {
    const p = baseProject();
    p.dataAccessGraph = {
      nodes: [
        { id: "file::src/db.rb", name: "db.rb", kind: "file", filePath: "src/db.rb", inboundCount: 0, outboundCount: 2 },
        { id: "db::DBIx::Class", name: "DBIx::Class", kind: "datastore", filePath: "", inboundCount: 2, outboundCount: 0 },
        { id: "entity::DBIx::Class::users", name: "users", kind: "entity", filePath: "", inboundCount: 1, outboundCount: 0 },
        { id: "entity::Microsoft::EntityFrameworkCore::User", name: "User", kind: "entity", filePath: "", inboundCount: 1, outboundCount: 0 },
      ],
      edges: [
        { source: "file::src/db.rb", target: "db::DBIx::Class", calls: [{ name: "find", line: 3 }], total: 1 },
        { source: "file::src/db.rb", target: "entity::DBIx::Class::users", calls: [], total: 4 },
      ],
    };
    roundTrips(p);
  });

  it("symbolLinks with Perl '::' symbols", () => {
    const p = baseProject();
    p.symbolLinks = [
      {
        sourceFile: "lib/App/Ctrl.pm",
        sourceSymbol: "App::Controller::Ctrl.login",
        sourceLine: 12,
        callName: "App::Model::User->find",
        targetFile: "lib/App/Model/User.pm",
        targetSymbol: "App::Model::User.find",
        targetLine: 7,
        confidence: "INFERRED",
      },
    ];
    roundTrips(p);
  });

  it("classGraph external, file, and interface nodes", () => {
    const p = baseProject();
    p.classGraph = {
      nodes: [
        { id: "src/x.ts::Foo", name: "Foo", filePath: "src/x.ts", isInterface: false, isExternal: false, isFile: false, inboundCount: 0, outboundCount: 1 },
        { id: "src/x.ts::IBar", name: "IBar", filePath: "src/x.ts", isInterface: true, isExternal: false, isFile: false, inboundCount: 1, outboundCount: 0 },
        { id: "::EventEmitter", name: "EventEmitter", filePath: "", isInterface: false, isExternal: true, isFile: false, inboundCount: 1, outboundCount: 0 },
        { id: "file::src/x.ts", name: "x.ts", filePath: "src/x.ts", isInterface: false, isExternal: false, isFile: true, inboundCount: 0, outboundCount: 0 },
      ],
      edges: [
        { source: "src/x.ts::Foo", target: "src/x.ts::IBar", byKind: { implements: 1 }, total: 1, category: "inheritance" },
        { source: "src/x.ts::Foo", target: "::EventEmitter", byKind: { instantiation: 1 }, total: 1, category: "function" },
      ],
    };
    roundTrips(p);
  });

  it("blastRadius typeUsages with isInterface false/true and sparse optionals", () => {
    const p = baseProject();
    p.blastRadius = [
      {
        filePath: "src/m.ts",
        directDependents: 1,
        transitiveDependents: 0,
        impactScore: 2,
        centrality: 3,
        level: "low",
        affectedFiles: ["src/a.ts"],
        transitiveFiles: [],
        dependsOn: [],
        exportedSymbols: [{ name: "M", usedByCount: 1, callers: [{ file: "src/a.ts", line: 4 }] }],
        changeRisk: "safe",
        maxDepth: 1,
        typeUsages: [
          {
            typeName: "M",
            definedAt: { line: 2, isInterface: false },
            usageByKind: { field: 1 },
            totalUsages: 1,
            usedByFiles: ["src/a.ts"],
            usagesByFile: [{ filePath: "src/a.ts", count: 1, byKind: { field: 1 }, sites: [{ symbol: "A.m", line: 5, kind: "field" }] }],
            impactScore: 2,
            level: "low",
            changeRisk: "safe",
          },
        ],
      },
    ];
    roundTrips(p);
  });

  it("entityGraph columns/edges tri-state optionals and null orm", () => {
    const p = baseProject();
    p.entityGraph = {
      nodes: [
        {
          id: "src/e.ts::User",
          name: "User",
          orm: "prisma",
          kind: "entity",
          filePath: "src/e.ts",
          columns: [
            { name: "id", type: "Int", isPrimaryKey: true },
            { name: "bio", type: null, isPrimaryKey: false },
            { name: "orgId", type: "Int", isPrimaryKey: false, isForeignKey: true },
          ],
          line: 1,
          referencingModels: [{ id: "src/dto.ts::UserDto", name: "UserDto", filePath: "src/dto.ts", isInterface: true, kinds: ["field"], count: 2 }],
        },
        { id: "src/e.ts::Status", name: "Status", orm: null, kind: "enum", filePath: "src/e.ts", columns: [], line: 9 }, // no referencingModels key
      ],
      edges: [
        { source: "src/e.ts::User", target: "src/e.ts::User", sourceCardinality: "one", targetCardinality: "many", fields: ["self"], foreignKey: null, joinTable: null, selfRef: true },
        { source: "src/e.ts::User", target: "src/e.ts::Status", sourceCardinality: "many", targetCardinality: "one", fields: ["status"], foreignKey: "statusId" }, // joinTable/orm/confidence/selfRef absent
      ],
    };
    roundTrips(p);
  });

  it("complexity with duplicate function names at different lines (overload)", () => {
    const p = baseProject();
    p.complexity = [
      {
        filePath: "src/u.pas",
        totalComplexity: 3,
        maxComplexity: 2,
        averageComplexity: 1.5,
        functions: [
          { functionName: "TUser.Create", complexity: 1, line: 21, endLine: 21 },
          { functionName: "TUser.Create", complexity: 2, line: 22, endLine: 22 },
        ],
      },
    ];
    roundTrips(p);
  });
});
