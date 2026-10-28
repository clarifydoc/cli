import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { readCpp } from "./antlr.js";

// The plugin's meta registers the language's wrapper types (`unique_ptr`) with the type normalizer.
beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

/** A file as the parse reads it (`antlr`) or as the patterns do (`regex`). */
const readers = {
  antlr: (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "cpp", undefined, readCpp(src)), projectId: "root" }),
  regex: (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "cpp"), projectId: "root" }),
};

const coachH = `#pragma once
class Coach {
 public:
  void drill();
};
class Physio {
 public:
  void drill();
};
`;
const coachCc = `#include "coach.h"
void Coach::drill() {}
void Physio::drill() {}
`;
const teamH = `#pragma once
#include <memory>
#include "coach.h"
class Team {
 public:
  void a(Coach* p);
  void b();
 private:
  Coach* coach_;
  std::unique_ptr<Physio> physio_;
};
`;
const teamCc = `#include "team.h"
void Team::a(Coach* p) {
  p->drill();
}
void Team::b() {
  Coach local;
  local.drill();
  auto sp = std::make_unique<Physio>();
  sp->drill();
  this->coach_->drill();
  physio_->drill();
}
`;

const linksOf = (read: (src: string, rel: string) => FileAnalysis, files: Record<string, string>) =>
  buildSymbolLinks(Object.entries(files).map(([rel, src]) => read(src, rel)))
    .map((l) => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetSymbol}`)
    .sort();

describe.each(Object.entries(readers))("C++ receivers (%s)", (_, read) => {
  it("names a call through `->` on its receiver, which the linker types by its declaration", () => {
    expect(linksOf(read, { "src/coach.h": coachH, "src/coach.cc": coachCc, "src/team.h": teamH, "src/team.cc": teamCc })).toEqual([
      "Team.a@3 p.drill -> Coach.drill",
      "Team.b@10 coach_.drill -> Coach.drill",
      "Team.b@11 physio_.drill -> Physio.drill",
      "Team.b@7 local.drill -> Coach.drill",
      "Team.b@9 sp.drill -> Physio.drill",
    ]);
  });

  it("keeps a namespace on the call it qualifies, so a project member of the same name never takes it", () => {
    const main = `#include <algorithm>
class Table {
 public:
  int find(int k);
  void sort();
};
int Table::find(int k) { return k; }
void Table::sort() { std::sort(rows_.begin(), rows_.end()); }
int scan(int* v) { return *std::find(v, v + 3, 3); }
`;
    expect(linksOf(read, { "src/main.cc": main })).toEqual([]);
    const fns = read(main, "src/main.cc").classes.flatMap((c) => c.methods).concat(read(main, "src/main.cc").functions);
    expect(fns.flatMap((f) => f.calls).filter((c) => c.name.startsWith("std.")).map((c) => `${c.name}:${c.receiverType}`)).toEqual(["std.sort:std", "std.find:std"]);
  });

  it("gives a namespace the file opens back its bare names", () => {
    const src = `namespace league {
namespace detail {
int rank(int x) { return x; }
}
int table() { return detail::rank(2) + std::max(1, 2); }
}
`;
    expect(read(src, "src/table.cc").functions.find((f) => f.name === "table")?.calls.map((c) => c.name)).toEqual(["rank", "std.max"]);
    expect(linksOf(read, { "src/table.cc": src })).toEqual(["table@5 rank -> rank"]);
  });

  it("reads the class after an export macro, and a field before an annotation macro", () => {
    const kitH = `#pragma once
class Mutex {};
class Coach { public: void drill(); };
class CLUB_API Kit {
 public:
  void wash();
 private:
  Mutex mu_;
  Coach coach_ GUARDED_BY(mu_);
};
class URL { public: void open(); };
`;
    const kit = read(kitH, "kit.h");
    expect(kit.classes.map((c) => `${c.name}(${c.properties.map((p) => `${p.name}:${p.type}`).join(",")})`)).toEqual(["Mutex()", "Coach()", "Kit(mu_:Mutex,coach_:Coach)", "URL()"]);
    const kitCc = `#include "kit.h"
void Coach::drill() {}
void Kit::wash() { coach_.drill(); }
`;
    expect(linksOf(read, { "kit.h": kitH, "kit.cc": kitCc })).toEqual(["Kit.wash@3 coach_.drill -> Coach.drill"]);
  });

  it("reads a field before a trailing comment and a constant pointer, and no class from a forward declaration", () => {
    const src = `#pragma once
class Slice;
class Garage {
 private:
  Car* const car_;  // the one it services
  Lift lift_;       /* owned */
  friend class Inspector;
};
`;
    expect(read(src, "garage.h").classes.map((c) => `${c.name}(${c.properties.map((p) => `${p.name}:${p.type}`).join(",")})`)).toEqual(["Garage(car_:Car,lift_:Lift)"]);
  });

  it("types a local built by a call through what the call makes", () => {
    const src = `#include "coach.h"
void pick() {
  auto c = Coach();
  c.drill();
}
`;
    expect(linksOf(read, { "src/coach.h": coachH, "src/coach.cc": coachCc, "src/pick.cc": src })).toEqual([
      "pick@3 Coach -> Coach",
      "pick@4 c.drill -> Coach.drill",
    ]);
  });

  it("calls the caller's own part of a type whose member each platform's file defines", () => {
    const h = `#pragma once
struct Spawner {
  bool Start(int n);
  int pid_;
  int status_;
};
`;
    const posix = `#include "spawner.h"
bool Spawner::Start(int n) { return n > 0; }
void Launch() {
  Spawner* s = new Spawner();
  s->Start(1);
}
`;
    const win = `#include "spawner.h"
bool Spawner::Start(int n) { return n > 1; }
`;
    expect(linksOf(read, { "src/spawner.h": h, "src/spawner-posix.cc": posix, "src/spawner-win32.cc": win })
      .filter((l) => l.includes("s.Start"))).toEqual(["Launch@5 s.Start -> Spawner.Start"]);
    const links = buildSymbolLinks([read(h, "src/spawner.h"), read(posix, "src/spawner-posix.cc"), read(win, "src/spawner-win32.cc")]);
    expect(links.find((l) => l.callName === "s.Start")?.targetFile).toBe("src/spawner-posix.cc");
  });

  it("takes a type from the header the file includes over a same-named class another header nests", () => {
    const iteratorH = `#pragma once
class Iterator {
 public:
  virtual void Next() = 0;
};
`;
    const tableH = `#pragma once
class Table {
 public:
  class Iterator {
   public:
    void Next() { step(); }
  };
};
`;
    const cc = `#include "league/iterator.h"
void Walk(Iterator* it) {
  it->Next();
}
`;
    const links = buildSymbolLinks([read(iteratorH, "include/league/iterator.h"), read(tableH, "src/table.h"), read(cc, "src/walk.cc")]);
    expect(links.filter((l) => l.callName === "it.Next").map((l) => `${l.targetFile}:${l.targetSymbol}`)).toEqual(["include/league/iterator.h:Iterator.Next"]);
  });
});

