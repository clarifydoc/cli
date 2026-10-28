import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, ClassInfo, DiBinding, FileAnalysis, FunctionInfo, PropertyInfo } from "../types/analysis.js";

/**
 * Dispatch through an abstract base class, the way interfaces already get it:
 * a typed receiver of an abstract class with one concrete subclass, a base
 * method calling its own abstract method, a container bean injected into a
 * field typed by its abstract base, and the fan-out from every abstract
 * method to its overrides. Hand-built analyses, as a plugin emits them.
 */

const call = (name: string, line = 10): CallInfo => ({ name, kind: "internal", target: null, line });

const method = (name: string, line: number, calls: CallInfo[] = [], extra: Partial<FunctionInfo> = {}): FunctionInfo =>
  ({ name, line, endLine: line, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [], ...extra });

const prop = (name: string, type: string): PropertyInfo =>
  ({ name, type, visibility: "private", isStatic: false, isReadonly: true });

const cls = (name: string, o: Partial<ClassInfo> = {}): ClassInfo => ({
  name,
  kind: "class",
  extends: null,
  implements: [],
  methods: [],
  properties: [],
  decorators: [],
  isExported: true,
  line: 1,
  endLine: 30,
  ...o,
});

const file = (filePath: string, classes: ClassInfo[], diBindings?: DiBinding[]): FileAnalysis =>
  ({
    filePath,
    projectId: "root",
    language: "java",
    functions: [],
    classes,
    imports: [],
    exports: [],
    routes: [],
    dataSources: [],
    ...(diBindings ? { diBindings } : {}),
  } as unknown as FileAnalysis);

const base = (): FileAnalysis =>
  file("league/AbstractNotifier.java", [cls("AbstractNotifier", {
    abstract: true,
    methods: [
      method("notifyClub", 3, [call("send", 3)]),
      method("send", 4, [], { abstract: true }),
    ],
  })]);

const email = (): FileAnalysis =>
  file("league/EmailNotifier.java", [cls("EmailNotifier", { extends: "AbstractNotifier", methods: [method("send", 7)] })]);

const sms = (): FileAnalysis =>
  file("league/SmsNotifier.java", [cls("SmsNotifier", { extends: "AbstractNotifier", methods: [method("send", 9)] })]);

const garage = (calls: CallInfo[]): FileAnalysis =>
  file("league/Garage.java", [cls("Garage", {
    properties: [prop("notifier", "AbstractNotifier")],
    methods: [method("open", 10, calls)],
  })]);

const links = (analyses: FileAnalysis[]) => buildSymbolLinks(analyses);
const edges = (analyses: FileAnalysis[], from: string) =>
  links(analyses).filter((l) => l.sourceSymbol === from).map((l) => `${l.callName} -> ${l.targetSymbol} [${l.strategy}/${l.relation}]`).sort();

describe("abstract-class dispatch", () => {
  it("a base method's call of its own abstract method runs the one override", () => {
    expect(edges([base(), email()], "AbstractNotifier.notifyClub")).toEqual([
      "send -> AbstractNotifier.send [injection/reference]",
      "send -> EmailNotifier.send [interface-redirect/calls]",
    ]);
  });

  it("with several overrides the call stays on the abstract method, which fans out to each", () => {
    const all = links([base(), email(), sms()]);
    expect(all.filter((l) => l.sourceSymbol === "AbstractNotifier.notifyClub").map((l) => l.targetSymbol)).toEqual(["AbstractNotifier.send"]);
    const fanout = all.filter((l) => l.strategy === "interface-fanout").map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`).sort();
    expect(fanout).toEqual(["AbstractNotifier.send -> EmailNotifier.send", "AbstractNotifier.send -> SmsNotifier.send"]);
    expect(all.find((l) => l.strategy === "interface-fanout")?.navigational).toBe(true);
  });

  it("a subclass calling the abstract method on itself dispatches below its own class", () => {
    const mid = file("league/BulkNotifier.java", [cls("BulkNotifier", {
      abstract: true,
      extends: "AbstractNotifier",
      methods: [method("flush", 5, [call("this.send", 5)])],
    })]);
    const bulkMail = file("league/BulkMailNotifier.java", [cls("BulkMailNotifier", { extends: "BulkNotifier", methods: [method("send", 6)] })]);
    // EmailNotifier also overrides `send`, but it is no BulkNotifier.
    expect(edges([base(), email(), mid, bulkMail], "BulkNotifier.flush")).toContain("this.send -> BulkMailNotifier.send [interface-redirect/calls]");
  });

  it("a field typed by an abstract class with one concrete subclass reaches that subclass", () => {
    expect(edges([base(), email(), garage([call("notifier.send"), call("notifier.notifyClub", 11)])], "Garage.open")).toEqual([
      "notifier.notifyClub -> AbstractNotifier.notifyClub [injection/calls]",
      "notifier.send -> AbstractNotifier.send [injection/reference]",
      "notifier.send -> EmailNotifier.send [interface-redirect/calls]",
    ]);
  });

  it("an abstract subclass is no concrete one, and a test double is no production one", () => {
    const mid = file("league/BulkNotifier.java", [cls("BulkNotifier", { abstract: true, extends: "AbstractNotifier" })]);
    const fake = file("src/test/java/league/FakeNotifier.java", [cls("FakeNotifier", { extends: "AbstractNotifier", methods: [method("send", 3)] })]);
    expect(edges([base(), email(), mid, fake, garage([call("notifier.send")])], "Garage.open"))
      .toContain("notifier.send -> EmailNotifier.send [interface-redirect/calls]");
  });

  it("a concrete base class is not dispatched through", () => {
    const concrete = file("league/AbstractNotifier.java", [cls("AbstractNotifier", { methods: [method("send", 4)] })]);
    expect(edges([concrete, email(), garage([call("notifier.send")])], "Garage.open")).toEqual([
      "notifier.send -> AbstractNotifier.send [injection/calls]",
    ]);
  });

  it("a bean registered under every supertype answers a field typed by its abstract base", () => {
    const bean = (name: string, line: number): DiBinding =>
      ({ service: "", implementation: name, line, via: "@Component", allInterfaces: true, abstractBases: true });
    // Two concrete subclasses, one of them a bean: the container decides.
    const emailBean = file("league/EmailNotifier.java", email().classes, [bean("EmailNotifier", 3)]);
    expect(edges([base(), emailBean, sms(), garage([call("notifier.send")])], "Garage.open"))
      .toContain("notifier.send -> EmailNotifier.send [di-binding/calls]");
    // Without `abstractBases` the registration names interfaces only, and two subclasses decide nothing.
    const ifaceOnly = file("league/EmailNotifier.java", email().classes, [{ ...bean("EmailNotifier", 3), abstractBases: false }]);
    expect(edges([base(), ifaceOnly, sms(), garage([call("notifier.send")])], "Garage.open"))
      .toEqual(["notifier.send -> AbstractNotifier.send [injection/calls]"]);
  });
});

describe("interface redirect with sub-interfaces", () => {
  it("does not take the one direct implementation when an extending interface has implementations too", () => {
    const provider = file("league/IProvider.java", [cls("IProvider", { kind: "interface", methods: [method("isValid", 2)] })]);
    const seasonal = file("league/ISeasonProvider.java", [cls("ISeasonProvider", { kind: "interface", extends: "IProvider" })]);
    const match = file("league/MatchProvider.java", [cls("MatchProvider", { implements: ["IProvider"], methods: [method("isValid", 4)] })]);
    const season = file("league/SeasonProvider.java", [cls("SeasonProvider", { implements: ["ISeasonProvider"], methods: [method("isValid", 4)] })]);
    const user = file("league/TransferDesk.java", [cls("TransferDesk", {
      properties: [prop("provider", "IProvider")],
      methods: [method("check", 10, [call("provider.isValid")])],
    })]);
    expect(edges([provider, seasonal, match, season, user], "TransferDesk.check")).toEqual(["provider.isValid -> IProvider.isValid [injection/calls]"]);
    // Without the second family the one implementation is the target, as before.
    expect(edges([provider, seasonal, match, user], "TransferDesk.check")).toContain("provider.isValid -> MatchProvider.isValid [interface-redirect/calls]");
  });
});

describe("interface redirect with sub-interfaces implemented by a subclass", () => {
  it("keeps the one implementation when the extending interface's implementations inherit from it", () => {
    const repo = file("league/IRepo.java", [cls("IRepo", { kind: "interface", methods: [method("all", 2)] })]);
    const clubRepoIface = file("league/IClubRepo.java", [cls("IClubRepo", { kind: "interface", extends: "IRepo" })]);
    const base = file("league/BasicRepo.java", [cls("BasicRepo", { implements: ["IRepo"], methods: [method("all", 4)] })]);
    const clubRepo = file("league/ClubRepo.java", [cls("ClubRepo", { extends: "BasicRepo", implements: ["IClubRepo"] })]);
    const user = file("league/Garage.java", [cls("Garage", {
      properties: [prop("repo", "IRepo")],
      methods: [method("park", 10, [call("repo.all")])],
    })]);
    expect(edges([repo, clubRepoIface, base, clubRepo, user], "Garage.park")).toContain("repo.all -> BasicRepo.all [interface-redirect/calls]");
  });
});

describe("interface fan-out to implementations of extending interfaces", () => {
  const provider = () => file("league/IProvider.java", [cls("IProvider", { kind: "interface", methods: [method("isValid", 2)] })]);
  const seasonal = () => file("league/ISeasonProvider.java", [cls("ISeasonProvider", { kind: "interface", extends: "IProvider", methods: [method("season", 3)] })]);
  const cup = () => file("league/ICupProvider.java", [cls("ICupProvider", { kind: "interface", extends: "ISeasonProvider" })]);
  const match = () => file("league/MatchProvider.java", [cls("MatchProvider", { implements: ["IProvider"], methods: [method("isValid", 4)] })]);
  const season = () => file("league/SeasonProvider.java", [cls("SeasonProvider", { implements: ["ISeasonProvider"], methods: [method("isValid", 4), method("season", 6)] })]);
  const final = () => file("league/CupFinalProvider.java", [cls("CupFinalProvider", { implements: ["ICupProvider"], methods: [method("isValid", 5)] })]);

  it("reaches a class implementing an interface that extends the declared one, at any depth", () => {
    expect(edges([provider(), seasonal(), cup(), match(), season(), final()], "IProvider.isValid")).toEqual([
      "isValid -> CupFinalProvider.isValid [interface-fanout/implements]",
      "isValid -> MatchProvider.isValid [interface-fanout/implements]",
      "isValid -> SeasonProvider.isValid [interface-fanout/implements]",
    ]);
    // The extending interface's own methods fan out from there only.
    expect(edges([provider(), seasonal(), cup(), match(), season(), final()], "ISeasonProvider.season"))
      .toEqual(["season -> SeasonProvider.season [interface-fanout/implements]"]);
  });

  it("does not fan out to an extending interface's restatement of the method", () => {
    const restated = file("league/ISeasonProvider.java", [cls("ISeasonProvider", { kind: "interface", extends: "IProvider", methods: [method("isValid", 3)] })]);
    const bare = file("league/SeasonProvider.java", [cls("SeasonProvider", { implements: ["ISeasonProvider"] })]);
    expect(edges([provider(), restated, bare], "IProvider.isValid")).toEqual([]);
  });

  it("lists a class implementing both the interface and an extending one once", () => {
    const both = file("league/SeasonProvider.java", [cls("SeasonProvider", { implements: ["IProvider", "ISeasonProvider"], methods: [method("isValid", 4)] })]);
    expect(links([provider(), seasonal(), both]).filter((l) => l.sourceSymbol === "IProvider.isValid")).toHaveLength(1);
  });
});
