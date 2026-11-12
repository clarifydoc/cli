import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { readC } from "./antlr.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["c"]);
});

const read = (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "c", undefined, readC(src)), projectId: "root" });

const clubH = `#ifndef CLUB_H
#define CLUB_H
struct club;
typedef void (*handler_t)(int);

struct club_ops {
    void (*sign)(struct club *c);
    void (*release)(struct club *c);
};

struct club_conf {
    struct club_ops ops;
};

struct club {
    int id;
    void (*on_sign)(int);
    const struct club_ops *ops;
};

struct rival_ops {
    void (*sign)(struct rival *r);
};

struct rival {
    int id;
    void (*on_sign)(int);
    const struct rival_ops *ops;
};
#endif
`;

const clubC = `#include "club.h"

static void save_club(int n) {}
static void club_sign(struct club *c) {}
static void club_release(struct club *c) {}
static void conf_sign(struct club *c) {}
static void on_kick(int n) {}
static void on_goal(int n) {}
static void rival_sign(struct rival *r) {}
static void rival_hook(int n) {}

static const struct club_ops club_table = { .sign = club_sign, .release = club_release };
static struct club_conf conf = { .ops = { .sign = conf_sign } };
static handler_t handlers[] = { on_kick, on_goal };
static handler_t g_cb;

static void run_cb(handler_t cb, int n) {
    cb(n);
}

void local_copy(void) {
    void (*fp)(int) = save_club;
    handler_t q = fp;
    run_cb(q, 1);
}

void deref_call(void) {
    void (*fp)(int) = on_goal;
    (*fp)(2);
}

handler_t pick(void) { return &save_club; }
void use_pick(void) { handler_t h = pick(); h(7); }

void set_cb(handler_t cb) { g_cb = cb; }
void fire(void) { g_cb(4); }
void wire(void) { set_cb(on_kick); }

void store(struct club *c, struct rival *r) {
    c->on_sign = save_club;
    r->on_sign = rival_hook;
}
void run_club(struct club *c) { c->on_sign(5); }
void run_rival(struct rival *r) { r->on_sign(6); }

void by_table(struct club *c, int i) {
    c->ops->sign(c);
    club_table.release(c);
    handlers[i](3);
}
void by_conf(struct club_conf *k, struct club *c) { k->ops.sign(c); }
void by_rival(struct rival *r) { r->ops->sign(r); }
void rival_table(struct rival *r) {
    static const struct rival_ops local = { .sign = rival_sign };
    local.sign(r);
}
`;

// A same-named static function in another translation unit: never the target.
const decoyC = `static void save_club(int n) {}
static void on_kick(int n) {}
static void club_sign(void *c) {}
void unrelated(void) { save_club(1); }
`;

function links(): string[] {
  const analyses = [read(clubH, "src/club.h"), read(clubC, "src/club.c"), read(decoyC, "src/decoy.c")];
  return buildSymbolLinks(analyses)
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

describe("C function values followed to the call that runs them", () => {
  const found = links();
  it("a function pointer copied and handed to a wrapper that calls it", () => {
    expect(found).toContain("run_cb@18 cb -> src/club.c::save_club");
  });
  it("a call through a dereferenced pointer", () => {
    expect(found).toContain("deref_call@29 fp -> src/club.c::on_goal");
  });
  it("a function returned from a factory and called by its caller", () => {
    expect(found).toContain("use_pick@33 h -> src/club.c::save_club");
  });
  it("a global holding a callback set in one function and called in another", () => {
    expect(found).toContain("fire@36 g_cb -> src/club.c::on_kick");
  });
  it("a struct field set in one function and called in another, per struct type", () => {
    expect(found).toContain("run_club@43 on_sign -> src/club.c::save_club");
    expect(found).toContain("run_rival@44 on_sign -> src/club.c::rival_hook");
    expect(found).not.toContain("run_rival@44 on_sign -> src/club.c::save_club");
    expect(found).not.toContain("run_club@43 on_sign -> src/club.c::rival_hook");
  });
  it("an ops table filled by designated initializers, called through any pointer to its type", () => {
    expect(found).toContain("by_table@47 sign -> src/club.c::club_sign");
    expect(found).toContain("by_table@48 club_table.release -> src/club.c::club_release");
    expect(found).not.toContain("by_table@47 sign -> src/club.c::rival_sign");
    expect(found).not.toContain("by_rival@52 sign -> src/club.c::club_sign");
  });
  it("a nested table and a table declared inside a function", () => {
    expect(found).toContain("by_conf@51 ops.sign -> src/club.c::conf_sign");
    expect(found).toContain("rival_table@55 local.sign -> src/club.c::rival_sign");
    expect(found).toContain("by_rival@52 sign -> src/club.c::rival_sign");
    expect(found).not.toContain("by_conf@51 ops.sign -> src/club.c::rival_sign");
  });
  it("an array of handlers called by element", () => {
    expect(found).toContain("by_table@49 handlers -> src/club.c::on_kick");
    expect(found).toContain("by_table@49 handlers -> src/club.c::on_goal");
  });
  it("never reaches a namesake in another translation unit", () => {
    expect(found.filter((l) => l.includes("src/decoy.c"))).toEqual([]);
  });
});

// A `/*` inside a string or a line comment opens no comment: the code after it is still read.
const quirkC = `typedef void (*handler_t)(int);
static handler_t g_hook;
static void on_goal(int n) {}
static void log_path(const char *dir) {
    const char *glob = "lib/*.c";   // copy lib/*.c
    (void)glob; (void)dir;
}
void arm(void) { g_hook = on_goal; }
void fire(void) { g_hook(1); }
`;

describe("C text the reader must not be fooled by", () => {
  it("reads past a comment opener inside a string or a line comment", () => {
    const found = buildSymbolLinks([read(quirkC, "src/quirk.c")])
      .filter((l) => l.strategy === "value-flow")
      .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`);
    expect(found).toEqual(["fire g_hook -> on_goal"]);
  });
});

