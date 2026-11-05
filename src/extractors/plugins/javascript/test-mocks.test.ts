import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractMockedModules } from "./test-mocks.js";

const mocksOf = async (src: string) => extractMockedModules(await parseSource(src, "typescript" as any, "src/garage.spec.ts"), src);

describe("modules a test replaces with a double", () => {
  it("reads vi.mock and jest.mock (and doMock) with a literal specifier, a factory or not", async () => {
    expect(
      await mocksOf(`
vi.mock("@/api/clubs");
jest.mock('../garage', () => ({ park: jest.fn() }));
vi.doMock(\`./lift\`);
vi.mock(modulePath);
vi.mock(\`./bays/\${n}\`);
`),
    ).toEqual(["@/api/clubs", "../garage", "./lift"]);
  });

  it("leaves out a partial mock that keeps the module's own exports", async () => {
    expect(
      await mocksOf(`
vi.mock("./players", async (importOriginal) => ({ ...(await importOriginal()), getPlayers: vi.fn() }));
jest.mock("./transfers", () => ({ ...jest.requireActual("./transfers"), sign: jest.fn() }));
vi.mock("./staff", async () => ({ ...(await vi.importActual("./staff")), hire: vi.fn() }));
`),
    ).toEqual([]);
  });
});
