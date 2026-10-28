import { describe, it, expect } from "vitest";
import { buildSymbolSignatures } from "./symbol-signatures.js";
import { buildClassGraph } from "./data-model-blast.js";
import { buildImportIndex } from "./import-index.js";
import type { FileAnalysis, FunctionInfo, SymbolLink } from "../types/analysis.js";

const fn = (name: string, line: number, params: Array<[string, string | null]>, returnType: string | null): FunctionInfo =>
  ({
    name, line, endLine: line + 5, returnType,
    params: params.map(([n, type]) => ({ name: n, type, defaultValue: null })),
  }) as unknown as FunctionInfo;

const file = (filePath: string, parts: Partial<FileAnalysis>): FileAnalysis =>
  ({ filePath, language: "typescript", functions: [], classes: [], imports: [], exports: [], ...parts }) as unknown as FileAnalysis;

const link = (sf: string, ss: string, tf: string, ts: string, targetLine = 1): SymbolLink => ({
  sourceFile: sf, sourceSymbol: ss, sourceLine: 1, callName: ts, targetFile: tf, targetSymbol: ts, targetLine,
});

const cls = (name: string, extra: Record<string, unknown> = {}) =>
  ({ name, line: 1, endLine: 20, methods: [], properties: [{ name: "id", type: "string" }], decorators: [], ...extra });

describe("buildSymbolSignatures", () => {
  const analyses = [
    file("src/club.entity.ts", { classes: [cls("Club", { decorators: ["entity", "typeorm"] })] as never }),
    file("src/create-club.dto.ts", { classes: [cls("CreateClubDto")] as never }),
    file("src/club.service.ts", {
      classes: [cls("ClubService", {
        methods: [
          fn("create", 10, [["dto", "CreateClubDto"], ["force", "boolean"]], "Promise<Club>"),
          fn("findAll", 20, [], "Promise<Club[]>"),
          fn("unused", 30, [["x", "number"]], "void"),
        ],
      })] as never,
    }),
    file("src/club.controller.ts", { functions: [fn("post", 5, [["body", null]], null)] }),
  ];
  const links = [
    link("src/club.controller.ts", "post", "src/club.service.ts", "ClubService.create", 10),
    link("src/club.controller.ts", "post", "src/club.service.ts", "ClubService.findAll", 20),
  ];
  const sigs = buildSymbolSignatures(analyses, links, [], buildClassGraph(analyses), buildImportIndex(analyses));
  const of = (symbol: string) => sigs.find((s) => s.symbol === symbol);

  it("gives a linked method its parameters and return type, joined to the models they name", () => {
    expect(of("ClubService.create")).toEqual({
      file: "src/club.service.ts",
      symbol: "ClubService.create",
      params: [
        { name: "dto", type: "CreateClubDto", models: [{ name: "CreateClubDto", file: "src/create-club.dto.ts" }] },
        { name: "force", type: "boolean" },
      ],
      returns: { type: "Promise<Club>", models: [{ name: "Club", file: "src/club.entity.ts", entity: true }] },
    });
  });

  it("reads a model through a collection type", () => {
    expect(of("ClubService.findAll")?.returns?.models).toEqual([{ name: "Club", file: "src/club.entity.ts", entity: true }]);
  });

  it("keeps an untyped parameter by name and covers the calling end of a link", () => {
    expect(of("post")).toEqual({ file: "src/club.controller.ts", symbol: "post", params: [{ name: "body", type: null }] });
  });

  it("leaves out functions no link or data access reaches", () => {
    expect(of("ClubService.unused")).toBeUndefined();
  });

  it("refuses to pick between two declarations of a name the file neither imports nor declares", () => {
    const twice = [
      file("src/a/player.ts", { classes: [cls("Player")] as never }),
      file("src/b/player.ts", { classes: [cls("Player")] as never }),
      file("src/squad.ts", { functions: [fn("pick", 3, [["p", "Player"]], null)] }),
    ];
    const out = buildSymbolSignatures(twice, [link("src/x.ts", "main", "src/squad.ts", "pick", 3)], [], buildClassGraph(twice), buildImportIndex(twice));
    expect(out[0]?.params[0]).toEqual({ name: "p", type: "Player" });
  });
});
