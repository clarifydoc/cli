import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { readCpp } from "./antlr.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

const readers = {
  antlr: (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "cpp", undefined, readCpp(src)), projectId: "root" }),
  regex: (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "cpp"), projectId: "root" }),
};

const linksOf = (read: (src: string, rel: string) => FileAnalysis, files: Record<string, string>) =>
  buildSymbolLinks(Object.entries(files).map(([rel, src]) => read(src, rel)))
    .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}:${l.targetSymbol}`)
    .sort();

const header = `#pragma once
struct Player { void Work() {} int score() const { return 1; } };
`;

describe.each(Object.entries(readers))("template heads, wrappers and scope (%s)", (_name, read) => {
  it("a default argument with a comparison inside parentheses does not close the head", () => {
    const links = linksOf(read, {
      "player.h": header,
      "use.cpp": `#include "player.h"
template<int N = (4 > 2), class Player> void Run(Player& p) { p.Work(); }
void Real(Player& p) { p.Work(); }
`,
    });
    expect(links).toEqual(["Real p.Work -> player.h:Player.Work"]);
  });

  it("a nested name after template arguments naming a parameter is dependent", () => {
    const links = linksOf(read, {
      "ledger.h": `#pragma once
template<class M> struct Ledger { void Tally() {} };
struct Row { void Tick() {} };
`,
      "use.cpp": `#include "ledger.h"
template<class M> void Use(typename Ledger<M>::Row& row) { row.Tick(); }
template<class M> void Use2() { typename Ledger<M>::Row r; r.Tick(); }
template<class M> struct Holder { typename Ledger<M>::Row f; void Go() { f.Tick(); } };
void Real(Ledger<int>& l) { l.Tally(); }
`,
    });
    expect(links).toEqual(["Real l.Tally -> ledger.h:Ledger.Tally"]);
  });

  it("a project class named like a std wrapper is that class", () => {
    const links = linksOf(read, {
      "use.cpp": `template<class T> struct queue { void Work() {} };
struct Player { void Work() {} };
template<class T> void Own(T& t) {
  queue<T> q;
  q.Work();
}
template<class T> void Other(T& t) {
  std::stack<T> q;
  q.Work();
}
`,
    });
    expect(links.filter((l) => l.includes(".Work"))).toEqual(["Own q.Work -> use.cpp:queue.Work"]);
  });

  it("a class template's own nested type written out of class stays that class's", () => {
    const links = linksOf(read, {
      "use.cpp": `template<class K, class C> struct Squad { struct Slot; Slot* first(); };
template<class K, class C> struct Squad<K, C>::Slot { void Fill() {} };
template<class K, class C>
typename Squad<K, C>::Slot* Squad<K, C>::first() {
  Slot* x = nullptr;
  x->Fill();
  return x;
}
`,
    });
    expect(links).toContain("Squad.first x->Fill -> use.cpp:Squad::Slot.Fill".replace("->Fill", ".Fill"));
  });

  it("an explicit specialization is a function whose parameter is the class", () => {
    const links = linksOf(read, {
      "player.h": header,
      "use.cpp": `#include "player.h"
template<> void Run<Player>(Player& x) { x.Work(); }
`,
    });
    expect(links).toContain("Run x.Work -> player.h:Player.Work");
  });

  it("a type named through another namespace is not the file's anonymous-namespace class", () => {
    const links = linksOf(read, {
      "use.cpp": `namespace { struct Valve { void Open() {} }; }
struct Pump { other::Valve v; void Run() { v.Open(); } };
void Local(other::Valve& w) { w.Open(); }
void Loc2() { other::Valve z; z.Open(); }
void Own(Valve& z) { z.Open(); }
`,
    });
    expect(links).toEqual(["Own z.Open -> use.cpp:Valve.Open"]);
  });

  it("a namespace-qualified type beside the anonymous namespace's class reaches the namespace's class", () => {
    const links = linksOf(read, {
      "valve.h": `#pragma once
namespace other { struct Valve { void Open() {} }; }
`,
      "use.cpp": `#include "valve.h"
namespace {
struct Valve { void Open() {} };
}
struct Pump { other::Valve v; void Run() { v.Open(); } };
void Local(other::Valve& w) { w.Open(); }
`,
    });
    expect(links).toEqual(["Local w.Open -> valve.h:Valve.Open", "Pump.Run v.Open -> valve.h:Valve.Open"]);
  });

  it("a block-local alias chain through a pointer, a smart pointer and a file-level alias", () => {
    const links = linksOf(read, {
      "player.h": header,
      "use.cpp": `#include "player.h"
using Gk = Player;
void A() {
  using P = Player;
  using Q = P*;
  Q q = nullptr;
  q->Work();
}
void B() {
  using P = Player;
  using Q = std::unique_ptr<P>;
  Q q;
  q->Work();
}
void C() {
  using Q = Gk;
  Q q;
  q.Work();
}
void D() {
  using P = Player;
  using Q = P;
  Q q;
  q.Work();
}
`,
    });
    expect(links.filter((l) => l.endsWith("Player.Work"))).toEqual(["A", "B", "C", "D"].map((f) => `${f} q.Work -> player.h:Player.Work`));
  });
});
