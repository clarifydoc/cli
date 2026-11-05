import { beforeAll, describe, expect, it } from "vitest";
import { loadObjcReader } from "./tree-sitter.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { cppMeta } from "../cpp/meta.js";
import { isObjcHeader } from "../shared/objc-header.js";
import type { ParsedStructure } from "../../../types/language-plugin.js";

let read: (source: string) => ParsedStructure;
beforeAll(async () => {
  read = await loadObjcReader();
});

const IMPL = `#import "Club.h"
@interface Club () {
    Player *_scout;
}
@property (nonatomic, strong, readonly) Player *home;
@property (nonatomic, weak) id<ClubDelegate> delegate;
@end
@implementation Club
- (Player *)captainOf:(Club *)rival with:(NSNumber *)fee {
    Player *p = [[Player alloc] init];
    id q = [Player new];
    for (Player *each in self.squad) { [each retire]; }
    [rival promote];
    [self.home retire];
    [_scout retire];
    return p;
}
@end
`;

describe("Objective-C receivers", () => {
  for (const parsed of [false, true]) {
    it(`types parameters, return types, locals, properties and instance variables (${parsed ? "tree-sitter" : "patterns"})`, () => {
      const a = extractWithRegex(IMPL, "Club.m", "objc", undefined, parsed ? read(IMPL) : undefined);
      expect(a.classes.map((c) => c.name)).toEqual(["Club"]);
      const cls = a.classes[0]!;
      const m = cls.methods.find((x) => x.name === "captainOf")!;
      expect(m.returnType).toBe("Player");
      expect(m.params.map((p) => [p.name, p.type])).toEqual([["rival", "Club"], ["fee", "NSNumber"]]);
      expect(m.localTypes).toEqual(expect.arrayContaining([{ name: "p", type: "Player" }, { name: "q", type: "Player" }, { name: "each", type: "Player" }]));
      const props = Object.fromEntries(cls.properties.map((p) => [p.name, p.type]));
      expect(props).toMatchObject({ home: "Player", _home: "Player", delegate: "ClubDelegate", _scout: "Player" });
    });
  }

  it("reads an @interface header as a class with its superclass, protocols and properties, and no functions", () => {
    const header = "#import <Foundation/Foundation.h>\n@interface Club : NSObject <Scoring, NSCopying>\n@property (nonatomic) Player *captain;\n- (void)promote;\n- (Player *)captainOf:(Club *)rival;\n@end\n@protocol Scoring\n- (int)goals;\n@end\n";
    const a = extractWithRegex(header, "Club.h", "objc");
    expect(a.functions).toEqual([]);
    const club = a.classes.find((c) => c.name === "Club")!;
    expect([club.extends, club.implements]).toEqual(["NSObject", ["Scoring", "NSCopying"]]);
    expect(club.properties.map((p) => p.name)).toEqual(["captain", "_captain"]);
    const scoring = a.classes.find((c) => c.name === "Scoring")!;
    expect([scoring.kind, scoring.methods.map((m) => m.name)]).toEqual(["interface", ["goals"]]);
  });
});

describe("a .h's owner hands an Objective-C header over", () => {
  const pre = (path: string, src: string) => cppMeta.preprocess!(src, path);
  it("sniffs @interface and framework imports, never a C or C++ header", () => {
    expect(pre("Club.h", "@interface Club : NSObject\n@end\n")).toMatchObject({ language: "objc" });
    expect(pre("Club.h", "#import <UIKit/UIKit.h>\n")).toMatchObject({ language: "objc" });
    expect(pre("car.h", "#ifndef CAR_H\nstruct car *car_new(int wheels);\n#endif\n")).toBeNull();
    expect(pre("club.hpp", "@interface X\n")).toBeNull();
    expect(isObjcHeader("a.h", "class Club {};\n")).toBe(false);
  });
});
