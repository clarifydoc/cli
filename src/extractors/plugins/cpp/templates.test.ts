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
struct T { void Go() {} };
`;

describe.each(Object.entries(readers))("template parameters are not classes (%s)", (name, read) => {
  it("a function template's parameter named like a class", () => {
    const links = linksOf(read, {
      "player.h": header,
      "use.cpp": `#include "player.h"
template<class Player> void Run(Player& x) { x.Work(); }
template <typename T>
void Spin(T* t, const T& u) {
  t->Go();
  u.Go();
}
void Real(Player& p) { p.Work(); }
`,
    });
    expect(links).toEqual(["Real p.Work -> player.h:Player.Work"]);
  });

  it("a multi-line head, a local of the template type, and a non-type parameter", () => {
    const links = linksOf(read, {
      "player.h": header,
      "use.cpp": `#include "player.h"
template <
    typename T,
    int N>
void Spin() {
  T a;
  a.Go();
  std::unique_ptr<T> q;
  q->Go();
}
template<class Q> void Mixed(Player& real, Q& other) { real.Work(); other.Go(); }
`,
    });
    expect(links).toEqual(["Mixed real.Work -> player.h:Player.Work"]);
  });

  it("methods of a class template and its out-of-class definitions", () => {
    const links = linksOf(read, {
      "player.h": header,
      "box.h": `#include "player.h"
template<class T>
struct Box {
  T value;
  void f(T& t) { t.Go(); value.Go(); }
  void g(Player& p) { p.Work(); }
  void h(T& t);
};
template<class T>
void Box<T>::h(T& t) { t.Go(); }
`,
    });
    expect(links).toEqual(["Box.g p.Work -> player.h:Player.Work"]);
  });

  it("a name the head does not bind, and an explicit specialization, stay classes", () => {
    const links = linksOf(read, {
      "player.h": header,
      "use.cpp": `#include "player.h"
template<> void Run<Player>(Player& x) { x.Work(); }
template<class P> void Other(Player& x) { x.Work(); }
`,
    });
    expect(links).toContain("Other x.Work -> player.h:Player.Work");
  });

  it("operators, iterators and smart pointers over a template parameter", () => {
    const links = linksOf(read, {
      "player.h": `#pragma once
struct T { T operator+(const T& o) const { return o; } void Go() {} };
`,
      "use.cpp": `#include "player.h"
template <typename T>
T add(T a, T b) {
  std::vector<T> all;
  all.push_back(a);
  for (auto it = all.begin(); it != all.end(); ++it) it->Go();
  auto p = std::make_unique<T>();
  std::unique_ptr<T> q;
  (*q).Go();
  return a + b;
}
void Real(T a, T b) { T c = a + b; }
`,
    });
    expect(links.filter((l) => l.startsWith("add "))).toEqual([]);
    // The parser reads operators; the patterns do not.
    if (name === "antlr") expect(links).toEqual(["Real a.operator+ -> player.h:T.operator+"]);
  });

  it("binds only the names a head declares, template template parameters included", () => {
    const links = linksOf(read, {
      "player.h": header,
      "use.cpp": `#include "player.h"
template<template<class> class Box, class Q = std::allocator<class Player>>
void Pick(Box<Q>& b, Player& real, T& t) { real.Work(); t.Go(); }
`,
    });
    expect(links).toEqual(["Pick real.Work -> player.h:Player.Work", "Pick t.Go -> player.h:T.Go"]);
  });

  it("a class template written on one line", () => {
    const links = linksOf(read, {
      "player.h": header,
      "box.h": `#include "player.h"
template<class T> struct Box { T value; void f(T& t) { t.Go(); value.Go(); } };
`,
    });
    expect(links).toEqual([]);
  });

  it("a type that only mentions a template parameter stays the project class it names", () => {
    const links = linksOf(read, {
      "club.h": `#pragma once
template <class K, class V> struct Squad { int size() const { return 1; } bool same() const { return true; } };
template <class M> struct Fixture { void announce(M m) {} };
template <class M> struct Ledger { void find(int id) {} };
struct Kit { void wash() {} };
`,
      "use.cpp": `#include "club.h"
template <class K, class V>
bool operator==(const Squad<K, V>& lhs, const Squad<K, V>& rhs) { return lhs.size() == rhs.size(); }
template <class K, class V>
bool operator!=(const Squad<K, V>& lhs, const Squad<K, V>& rhs) { return !(lhs == rhs); }
template <typename M>
class Service {
  std::shared_ptr<Fixture<M>> fixture_;
  Kit<M> kit_;
  void go(M& m, Ledger<M>& ledger) {
    fixture_->announce(m);
    Ledger<M> tmp;
    tmp.find(1);
    ledger.find(2);
    m.wash();
  }
};
`,
    });
    expect(links).toEqual(expect.arrayContaining([
      "operator== lhs.size -> club.h:Squad.size",
      "operator== rhs.size -> club.h:Squad.size",
      "Service.go ledger.find -> club.h:Ledger.find",
      "Service.go tmp.find -> club.h:Ledger.find",
      "Service.go fixture_.announce -> club.h:Fixture.announce",
    ]));
    expect(links.filter((l) => l.includes("wash"))).toEqual([]);
  });
});
