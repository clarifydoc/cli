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

const typesH = `struct club;
typedef int (*club_pull_pt)(struct club *c);
typedef int (*player_cb)(int);
`;

const opsH = `#ifndef OPS_TABLE_H
#define OPS_TABLE_H
#include "types.h"
struct club_ops {
    const char *name;
    int flags;
    club_pull_pt scout;
    int (*release)(struct club *c);
    club_pull_pt transfer;
};
typedef struct {
    const char *label;
    player_cb on_sign;
    int (*on_sell)(int);
} player_ops_t;
struct manager {
    struct club_ops *ops;
    player_ops_t *pops;
};
#endif
`;

const implC = `#include "ops_table.h"
#define CLUB_FLAGS 7
#define CLUB_HEAD "x", 1
int club_scout(struct club *c) { return 1; }
int club_release(struct club *c) { return 2; }
int club_transfer(struct club *c) { return 3; }
int club_flagged(struct club *c) { return 4; }
int club_headed(struct club *c) { return 5; }
int club_extra(struct club *c) { return 6; }
int club_mixed(struct club *c) { return 7; }
int player_sign(int x) { return x; }
int player_sell(int x) { return x; }
static struct club_ops ops = { "club", 0, club_scout, club_release, club_transfer };
static struct club_ops flagged = { "f", CLUB_FLAGS, club_flagged };
static struct club_ops headed = { CLUB_HEAD, club_headed };
static struct club_ops too_many = { "a", 0, club_extra, club_extra, club_extra, club_extra };
static struct club_ops mixed = { "a", .flags = 1, club_mixed };
static player_ops_t pops = { "p", player_sign, player_sell };
`;

const useC = `#include "ops_table.h"
int run_scout(struct manager *m, struct club *x) { return m->ops->scout(x); }
int run_release(struct manager *m, struct club *x) { return m->ops->release(x); }
int run_transfer(struct manager *m, struct club *x) { return m->ops->transfer(x); }
int run_sign(struct manager *m) { return m->pops->on_sign(1); }
int run_sell(struct manager *m) { return m->pops->on_sell(1); }
`;

// Another struct of the same name, in headers the callers above never include.
// A tagged struct whose typedef closes its body inside `extern "C"`, and a tagless one, both filled by position.
const gearH = `#ifdef __cplusplus
extern "C" {
#endif
typedef struct club_gear {
    int (*shift)(int,
                 int);
    int (*brake)(int);
} club_gear_t;
typedef struct {
    const char *label;
    int (*honk)(int);
} car_horn_t;
struct garage {
    club_gear_t *gear;
    car_horn_t *horn;
};
#ifdef __cplusplus
}
#endif
`;
const gearC = `#include "gear.h"
int car_shift(int a, int b) { return a; }
int car_honk(int a) { return a; }
static club_gear_t gear = { car_shift };
static car_horn_t horn = { "h", car_honk };
int drive(struct garage *g) { return g->gear->shift(1, 2) + g->horn->honk(1); }
`;

const rivalH = `struct club_ops {
    const char *name;
    int (*release)(void *c);
};
struct rival {
    struct club_ops *ops;
};
`;
const rivalC = `#include "rival_ops.h"
int rival_release(void *c) { return 0; }
struct club_ops dops = { "d", rival_release };
int rival_run(struct rival *r) { return r->ops->release(0); }
`;

function links(): string[] {
  const analyses = [
    read(typesH, "src/types.h"),
    read(opsH, "src/ops_table.h"),
    read(implC, "src/impl.c"),
    read(useC, "src/use.c"),
    read(rivalH, "src/rival/rival_ops.h"),
    read(rivalC, "src/rival/rival.c"),
    read(gearH, "src/gear.h"),
    read(gearC, "src/gear.c"),
  ];
  return buildSymbolLinks(analyses)
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

describe("C structs of function pointers filled by a positional initializer", () => {
  const found = links();
  it("fills the fields by position, typedef-typed fields and a tagless typedef struct included", () => {
    expect(found).toContain("run_scout ops.scout -> src/impl.c::club_scout");
    expect(found).toContain("run_release ops.release -> src/impl.c::club_release");
    expect(found).toContain("run_transfer ops.transfer -> src/impl.c::club_transfer");
    expect(found).toContain("run_sign pops.on_sign -> src/impl.c::player_sign");
    expect(found).toContain("run_sell pops.on_sell -> src/impl.c::player_sell");
  });
  it("reads a typedef alias closing the body inside extern C, and a tagless typedef struct", () => {
    expect(found).toContain("drive gear.shift -> src/gear.c::car_shift");
    expect(found).toContain("drive horn.honk -> src/gear.c::car_honk");
  });
  it("takes fewer elements than fields, and an object-like macro of one value", () => {
    expect(found).toContain("run_scout ops.scout -> src/impl.c::club_flagged");
  });
  it("refuses an initializer a macro may widen, one with too many elements and one mixing designators", () => {
    expect(found.filter((l) => /club_(headed|extra|mixed)/.test(l))).toEqual([]);
  });
  it("never reaches the namesake struct of headers the caller does not include", () => {
    expect(found.filter((l) => l.includes("rival_release")).sort()).toEqual(["rival_run ops.release -> src/rival/rival.c::rival_release"]);
    expect(found).not.toContain("run_release ops.release -> src/rival/rival.c::rival_release");
  });
});
