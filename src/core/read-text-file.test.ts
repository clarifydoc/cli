import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { decodeText, readTextFile } from "./read-text-file.js";
import { collectExternalPackages } from "./dependency-inventory.js";

const utf16le = (s: string, bom = true): Buffer => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, "utf16le")]);
const utf16be = (s: string): Buffer => {
  const body = Buffer.from(s, "utf16le");
  body.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
};

describe("decodeText", () => {
  it("reads UTF-8 with and without a mark, UTF-16 by its mark, surrogates included", () => {
    expect(decodeText(Buffer.from("club = 1\n"))).toBe("club = 1\n");
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("club\n")]))).toBe("club\n");
    expect(decodeText(utf16le("club\r\nplayer\n"))).toBe("club\r\nplayer\n");
    expect(decodeText(utf16be("club\r\nplayer\n"))).toBe("club\r\nplayer\n");
    expect(decodeText(utf16le("goal \u{1f945}"))).toBe("goal \u{1f945}");
    expect(decodeText(utf16be("goal \u{1f945}"))).toBe("goal \u{1f945}");
  });

  it("reads a file with no mark as UTF-8 and survives an odd tail", () => {
    expect(decodeText(utf16le("club", false))).toContain("\0");
    expect(decodeText(Buffer.concat([utf16be("club"), Buffer.from([0x00])]))).toBe("club");
    expect(decodeText(Buffer.alloc(0))).toBe("");
  });
});

describe("manifests saved as UTF-16", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-utf16-"));
    await mkdir(join(dir, "le"));
    await mkdir(join(dir, "be"));
    const text = "requests==2.31.0\r\nflask>=3.0\r\n";
    await writeFile(join(dir, "le", "requirements.txt"), utf16le(text));
    await writeFile(join(dir, "be", "requirements.txt"), utf16be(text));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  for (const sub of ["le", "be"]) {
    it(`lists both packages of a UTF-16 ${sub.toUpperCase()} requirements.txt`, async () => {
      const pkgs = await collectExternalPackages(join(dir, sub), []);
      expect(pkgs.map((p) => p.name).sort()).toEqual(["flask", "requests"]);
    });
  }

  it("readTextFile decodes the same bytes", async () => {
    expect(await readTextFile(join(dir, "le", "requirements.txt"))).toBe("requests==2.31.0\r\nflask>=3.0\r\n");
  });
});

describe("source files saved as UTF-16", () => {
  it("reads the class of a UTF-16 C# file like its UTF-8 twin", async () => {
    const { analyzeFile } = await import("./file-analyzer.js");
    const { loadAllPlugins } = await import("../extractors/registry.js");
    await loadAllPlugins();
    const dir = await mkdtemp(join(tmpdir(), "clarifydoc-utf16-src-"));
    const text = "namespace League { public class Club { public void Promote() { } } }\r\n";
    const read = async (name: string, bytes: Buffer): Promise<string[]> => {
      await writeFile(join(dir, name), bytes);
      const out = join(dir, `out-${name}`);
      await mkdir(out);
      const result = await analyzeFile({ file: { absolutePath: join(dir, name), relativePath: name, language: "csharp" }, frameworkIds: [], projectId: "root", outputOpts: { outputDir: out, pretty: false }, verbose: false, projectRoot: dir, tsconfigAliases: new Map() } as never);
      return (result?.analysis.classes ?? []).map((c) => c.name);
    };
    expect(await read("Club8.cs", Buffer.from(text))).toEqual(["Club"]);
    expect(await read("Club16.cs", utf16le(text))).toEqual(["Club"]);
    expect(await read("Club16be.cs", utf16be(text))).toEqual(["Club"]);
    await rm(dir, { recursive: true, force: true });
  });
});
