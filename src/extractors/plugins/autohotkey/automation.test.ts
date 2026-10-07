import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor } from "../../registry.js";
import type { FileAnalysis, Language } from "../../../types/analysis.js";

/** Through the plugin's preprocess, as the analyzer runs it. */
function analyze(src: string, path: string, language: Language): FileAnalysis {
  const pre = pluginFor(language)!.preprocess?.(src, path);
  const p = pre && "sourceText" in pre ? pre : null;
  const analysis = extractWithRegex(p?.sourceText ?? src, path, language);
  p?.postExtract?.(analysis, src);
  return analysis;
}
const fns = (a: FileAnalysis) => a.functions.map((f) => [f.name, f.params.map((p) => p.name), f.calls.map((c) => c.name)]);

describe("AutoHotkey", () => {
  it("reads functions, classes, hotkeys and labels — never a call as a definition", () => {
    const a = analyze([
      "#Requires AutoHotkey v2.0",
      "#Include lib\\Orders.ahk",
      "#Include <Json>",
      "/* SaveAll() in a comment */",
      "Init()",
      "SetTimer(Poll, 60000)",
      "",
      "Init() {",
      "    global cfg := LoadConfig(\"app.ini\")",
      "    if (cfg.debug)",
      "        Log(\"debug\")",
      "}",
      "",
      "Poll() => Orders.Sync(cfg.url)",
      "",
      "class OrderWindow extends Gui {",
      "    title := \"Orders\"",
      "    Show(id, opts := \"\") {",
      "        this.Load(id)",
      "    }",
      "}",
      "",
      "^j::SendOrder(42)",
      "#n:: {",
      "    Run(\"notepad\")",
      "    SaveAll()",
      "}",
    ].join("\n"), "main.ahk", "autohotkey");
    expect(fns(a)).toEqual([
      ["<setup>", [], ["Init", "Poll"]],
      ["Init", [], ["LoadConfig", "Log"]],
      ["Poll", [], ["Orders.Sync"]],
      ["^j::", [], ["SendOrder"]],
      ["#n::", [], ["Run", "SaveAll"]],
    ]);
    expect(a.classes.map((c) => [c.name, c.extends, c.properties.map((p) => p.name), c.methods.map((m) => [m.name, m.params.map((p) => p.name)])])).toEqual([
      ["OrderWindow", "Gui", ["title"], [["Show", ["id", "opts"]]]],
    ]);
    expect(a.imports.map((i) => i.source)).toEqual(["./lib/Orders.ahk", "Json"]);
  });

  it("reads v1 labels and hotkeys that run to a return, and WinHttp calls", () => {
    const a = analyze([
      "Gosub, Refresh",
      "return",
      "Refresh:",
      "    http := ComObjCreate(\"WinHttp.WinHttpRequest.5.1\")",
      "    http.Open(\"POST\", \"https://crm.example.com/v2/sync\")",
      "    UpdateList()",
      "return",
      "F5::",
      "    Gosub, Refresh",
      "return",
    ].join("\n"), "legacy.ahk", "autohotkey");
    expect(fns(a)).toEqual([["<setup>", [], ["Refresh"]], ["Refresh", [], ["ComObjCreate", "http.Open", "UpdateList"]], ["F5::", [], ["Refresh"]]]);
    expect(a.dataSources.map((d) => d.name)).toEqual(["POST https://crm.example.com/v2/sync"]);
  });
});

describe("AutoIt", () => {
  it("reads Func … EndFunc, includes, SQL and HTTP — keywords and comment blocks never", () => {
    const a = analyze([
      "#include <Array.au3>",
      "#include \"lib\\db.au3\"",
      "#cs",
      "  SaveOrder() in a comment block",
      "#ce",
      "Main()",
      "",
      "Func Main()",
      "    Local $aOrders = LoadOrders(10)",
      "    If UBound($aOrders) > 0 Then _ArrayDisplay($aOrders)",
      "EndFunc",
      "",
      "Func LoadOrders($iLimit, ByRef $aOut = 0)",
      "    _SQLite_Query(-1, 'SELECT id, total FROM orders LIMIT ' & $iLimit, $hQuery)",
      "    Local $sJson = InetRead(\"https://crm.example.com/v2/orders\")",
      "    Return _ParseOrders($sJson)",
      "EndFunc",
    ].join("\n"), "app.au3", "autoit");
    expect(fns(a)).toEqual([
      ["<setup>", [], ["Main"]],
      ["Main", [], ["LoadOrders", "UBound", "_ArrayDisplay"]],
      ["LoadOrders", ["iLimit", "aOut"], ["_SQLite_Query", "InetRead", "_ParseOrders"]],
    ]);
    expect(a.imports.map((i) => i.source)).toEqual(["Array", "./lib/db.au3"]);
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}`)).toEqual(["database SELECT orders", "api-call GET https://crm.example.com/v2/orders"]);
  });
});

describe("AppleScript", () => {
  it("reads handlers, script objects, libraries and curl in shell scripts", () => {
    const a = analyze([
      "use AppleScript version \"2.4\"",
      "use script \"OrderLib\"",
      "(* saveAll() in a comment *)",
      "set orders to fetchOrders()",
      "repeat with o in orders",
      "    my closeOrder(o)",
      "end repeat",
      "",
      "on fetchOrders()",
      "    set json to do shell script \"curl -s https://crm.example.com/v2/orders\"",
      "    return parseOrders(json)",
      "end fetchOrders",
      "",
      "to closeOrder(anOrder)",
      "    try",
      "        do shell script \"curl -X POST https://crm.example.com/v2/orders/\" & anOrder & \"/close\"",
      "    on error errMsg",
      "        logError(errMsg)",
      "    end try",
      "end closeOrder",
      "",
      "script OrderCache",
      "    property items : {}",
      "    on add(anOrder)",
      "        set end of items to anOrder",
      "    end add",
      "end script",
    ].join("\n"), "orders.applescript", "applescript");
    expect(fns(a)).toEqual([
      ["<setup>", [], ["fetchOrders", "closeOrder"]],
      ["fetchOrders", [], ["parseOrders"]],
      ["closeOrder", ["anOrder"], ["logError"]],
    ]);
    expect(a.classes.map((c) => [c.name, c.properties.map((p) => p.name), c.methods.map((m) => [m.name, m.params.map((p) => p.name)])])).toEqual([
      ["OrderCache", ["items"], [["add", ["anOrder"]]]],
    ]);
    expect(a.imports.map((i) => i.source)).toEqual(["OrderLib"]);
    expect(a.dataSources.map((d) => d.name)).toEqual(["GET https://crm.example.com/v2/orders", "POST https://crm.example.com/v2/orders/{anOrder}/close"]);
  });
});
