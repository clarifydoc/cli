import { describe, it, expect } from "vitest";
import { applyHttpClientBases } from "./http-client-bases.js";
import { buildImportIndex } from "./import-index.js";
import type { FileAnalysis } from "../types/analysis.js";

const file = (filePath: string, extra: Partial<FileAnalysis>): FileAnalysis =>
  ({ filePath, language: "typescript", projectId: "root", imports: [], exports: [], functions: [], classes: [], routes: [], dataSources: [], ...extra } as unknown as FileAnalysis);

describe("applyHttpClientBases", () => {
  it("prepends the base of a client created here or imported", () => {
    const client = file("src/services/apiClient.ts", { httpClientBases: { apiClient: "/api" } });
    const users = file("src/services/userService.ts", {
      imports: [{ source: "./apiClient", specifiers: ["api"], isDefault: true, isNamespace: false, isType: false, line: 1 }],
    });
    const calls = [
      { kind: "api-call", name: "get", target: "/users", client: "api", calls: [], line: 3, filePath: "src/services/userService.ts" },
      { kind: "api-call", name: "get", target: "/api/users", client: "api", calls: [], line: 4, filePath: "src/services/userService.ts" },
      { kind: "api-call", name: "get", target: "https://x/users", client: "api", calls: [], line: 5, filePath: "src/services/userService.ts" },
      { kind: "api-call", name: "get", target: "/users", client: "other", calls: [], line: 6, filePath: "src/services/userService.ts" },
    ] as any[];
    const analyses = [client, users];
    expect(applyHttpClientBases(calls, analyses, buildImportIndex(analyses))).toBe(1);
    expect(calls.map((c) => c.target)).toEqual(["/api/users", "/api/users", "https://x/users", "/users"]);
  });
});
