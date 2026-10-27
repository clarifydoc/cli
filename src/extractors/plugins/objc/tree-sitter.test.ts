import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { loadObjcReader } from "./tree-sitter.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { ParsedStructure } from "../../../types/language-plugin.js";

let readObjc: (source: string) => ParsedStructure;
beforeAll(async () => {
  readObjc = await loadObjcReader();
});

const CLUBS = `#import "ClubController.h"

@implementation ClubController

- (void)loadClub:(NSInteger)clubId completion:(void (^)(Club *))done {
  [self.repo findClub:clubId];
  Club *club = [[Club alloc] initWithName:@"Rovers" city:nil];
  [[ClubService shared] refresh];
  NSLog(@"%@", [club name]);
  dispatch_async(queue, ^{ [self reloadSquad]; });
  self.onRefresh(YES);
  done(club);
}

+ (instancetype)shared {
  return nil;
}

@end

static void recordTransfer(Player *p) {
  saveTransfer(p);
}
`;

describe("Objective-C through tree-sitter", () => {
  it("reads methods and C functions with their spans", () => {
    const parsed = readObjc(CLUBS);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.line, f.endLine])).toEqual([
      ["loadClub", 5, 13],
      ["shared", 15, 17],
      ["recordTransfer", 21, 23],
    ]);
    expect(parsed.functions.find((f) => f.name === "recordTransfer")!.calls.map((c) => c.name)).toEqual(["saveTransfer"]);
  });

  it("names message sends on paths, constructions, other sends and in arguments, and called blocks", () => {
    const calls = readObjc(CLUBS).functions.find((f) => f.name === "loadClub")!.calls;
    expect(calls.map((c) => c.name)).toEqual([
      "repo.findClub",
      "Club.initWithName",
      "Club.alloc",
      "ClubService.shared().refresh",
      "ClubService.shared",
      "NSLog",
      "club.name",
      "dispatch_async",
      "self.reloadSquad",
      "self.onRefresh",
      "done",
    ]);
    expect(calls.find((c) => c.name === "Club.initWithName")).toMatchObject({ receiverType: "Club" });
  });

  it("names no @selector, @available or cast (real-repo FP)", () => {
    const calls = (body: string) => readObjc(`@implementation A\n- (void)f {\n${body}\n}\n@end\n`).functions[0]!.calls.map((c) => c.name);
    expect(calls("  SEL s = @selector(kickoff:);\n  if (@available(iOS 13, *)) { BOOL ok = (BOOL)flag; }")).toEqual([]);
  });

  it("counts the errors of a file the grammar cannot read, so core keeps the regex reading", () => {
    expect(readObjc("@implementation A\n- (void)f { [self g:; }\n@end\n").syntaxErrors).toBeGreaterThan(0);
  });
});

describe("Objective-C: tree-sitter and the patterns agree on the fixtures", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/**/*.{m,mm}", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} as the patterns do`, () => {
      const src = readFileSync(resolve(root, rel), "utf-8");
      const parsed = readObjc(src);
      expect(parsed.syntaxErrors).toBe(0);
      const shape = (a: ReturnType<typeof extractWithRegex>) =>
        a.classes.flatMap((c) => c.methods.map((m) => ({ name: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine, calls: m.calls.map((x) => x.name) })));
      expect(shape(extractWithRegex(src, rel, "objc", undefined, parsed))).toEqual(shape(extractWithRegex(src, rel, "objc")));
    });
  }
});
