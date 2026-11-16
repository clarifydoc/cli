import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import { readCpp } from "./antlr.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

const files = {
  "src/club.h": `#pragma once
class ClubWindow : public QDialog {
public:
  ClubWindow();
private slots:
  void saveClub();
  void resetClub(int id);
};
`,
  "src/club.cpp": `#include "club.h"
ClubWindow::ClubWindow() {
  connect(save, SIGNAL(clicked()), this, SLOT(saveClub()));
  connect(reset, SIGNAL(clicked()), this, SLOT(resetClub(int)));
  connect(save, &QPushButton::clicked, this, &ClubWindow::saveClub);
}
void ClubWindow::saveClub() { persist(); }
void ClubWindow::resetClub(int id) { clear(); }
`,
  // A namesake window with the same slot names: only the file's own class is connected.
  "src/team.h": `#pragma once
class TeamWindow : public QDialog {
public:
  TeamWindow();
private slots:
  void saveClub();
  void resetClub(int id);
};
`,
  "src/team.cpp": `#include "team.h"
TeamWindow::TeamWindow() {}
void TeamWindow::saveClub() { store(); }
void TeamWindow::resetClub(int id) { wipe(); }
`,
};

describe("Qt SLOT() macro slots", () => {
  it("hands the slot on as a pass, like &Class::slot, and never calls it", () => {
    const analyses = Object.entries(files).map(([rel, src]) => ({ ...extractWithRegex(src, rel, "cpp", undefined, readCpp(src)), projectId: "root" }));
    const links = buildSymbolLinks(analyses)
      .filter((l) => l.sourceFile === "src/club.cpp")
      .map((l) => `${l.callName} -> ${l.targetFile}:${l.targetSymbol} ${l.relation}`)
      .sort();
    expect(links).toEqual([
      "ClubWindow.saveClub -> src/club.cpp:ClubWindow.saveClub passes",
      "resetClub -> src/club.cpp:ClubWindow.resetClub passes",
      "saveClub -> src/club.cpp:ClubWindow.saveClub passes",
    ]);
  });
});
