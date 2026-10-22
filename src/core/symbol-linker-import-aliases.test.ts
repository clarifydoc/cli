import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis } from "../types/analysis.js";

const fn = (name: string, line: number, calls: CallInfo[] = []) =>
  ({ name, line, endLine: line + 4, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [] });
const call = (name: string, line: number, kind: CallInfo["kind"], target: string | null = null): CallInfo => ({ name, kind, target, line });
const file = (filePath: string, o: { functions?: unknown[]; imports?: unknown[]; exports?: unknown[] }): FileAnalysis =>
  ({ filePath, language: "typescript", projectId: "root", imports: o.imports ?? [], exports: o.exports ?? [], functions: o.functions ?? [], classes: [], routes: [], dataSources: [] }) as unknown as FileAnalysis;

describe("symbol links through an aliased import", () => {
  it("resolves the local alias to the module's export, and the file's own function of the export's name stays its own", () => {
    const sdk = file("packages/sdk/src/client.ts", {
      functions: [fn("addPlayersToSquad", 3), fn("addPlayersToSquads", 9)],
      exports: [{ name: "addPlayersToSquad", kind: "function", line: 3 }, { name: "addPlayersToSquads", kind: "function", line: 9 }],
    });
    const service = file("web/src/lib/services/squad.service.ts", {
      imports: [{ source: "../../../../packages/sdk/src/client", specifiers: ["signPlayers", "signPlayersEverywhere"], aliases: { signPlayers: "addPlayersToSquad", signPlayersEverywhere: "addPlayersToSquads" }, isDefault: false, isNamespace: false, isType: false, line: 1 }],
      functions: [
        fn("addToSquad", 5, [call("signPlayers", 6, "cross-file", "../../../../packages/sdk/src/client")]),
        fn("addEverywhere", 10, [call("addPlayersToSquads", 11, "internal")]),
        fn("addPlayersToSquads", 15, [call("signPlayersEverywhere", 16, "cross-file", "../../../../packages/sdk/src/client")]),
      ],
    });
    const links = buildSymbolLinks([sdk, service]).filter((l) => l.sourceFile === service.filePath && l.sourceSymbol !== "(reference)");
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetFile.split("/").pop()}::${l.targetSymbol}`)).toEqual([
      "addToSquad -> client.ts::addPlayersToSquad",
      "addEverywhere -> squad.service.ts::addPlayersToSquads",
      "addPlayersToSquads -> client.ts::addPlayersToSquads",
    ]);
  });
});
