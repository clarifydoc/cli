import { describe, expect, it } from "vitest";
import { readLua } from "./antlr.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import "../../registry.js";

const GATE = `--[[
    # commented-out configuration: mobile devices (phones) and requests (all)
    set $session_name StadiumSession;
]]
local stadium = require("stadium.gate")
local notes = [[ see kickoff (first) ]]

local function fail(reason)
  ngx.log(ngx.ERR, reason)
  return ngx.redirect("/login")
end

local token = os.getenv("GATE_TOKEN")
if token and (ngx.var.uri ~= "/") or not (token) then
  local ok = stadium.authenticate(token, { on_denied = function (r) return r end })
  if not ok then fail("denied") end
end
`;

const GARAGE = `local Garage = {}

function Garage:park(car)
  local slot = self.pool:lease(car.plate)
  local function log(msg) ngx.log(ngx.INFO, msg) end
  log("parked")
  return slot
end

Garage.close = function(self)
cleanup()
end

function Garage.open() return Garage.reset {} end

local json = require "cjson"
return Garage
`;

describe("Lua through ANTLR", () => {
  it("reads a script as the patterns do: <setup> and a local function's calls, no words in long brackets", () => {
    const parsed = readLua(GATE);
    expect(parsed.syntaxErrors).toBe(0);
    const a = extractWithRegex(GATE, "gate.lua", "lua", undefined, parsed);
    expect(a.functions.find((f) => f.name === "<setup>")?.calls.map((c) => c.name)).toEqual(["os.getenv", "stadium.authenticate", "fail"]);
    expect(a.functions.find((f) => f.name === "fail")).toMatchObject({ line: 8, endLine: 11, isExported: false });
    expect(a.functions.find((f) => f.name === "fail")?.calls.map((c) => c.name)).toEqual(["ngx.log", "ngx.redirect"]);
  });

  it("ends a function at its `end`, whatever the indentation, and gives a nested one its own calls", () => {
    const parsed = readLua(GARAGE);
    expect(parsed.functions.map((f) => [f.name, f.line, f.endLine])).toEqual([
      ["Garage:park", 3, 8],
      ["log", 5, 5],
      ["Garage.close", 10, 12],
      ["Garage.open", 14, 14],
    ]);
    const park = parsed.functions.find((f) => f.name === "Garage:park")!;
    expect(park.calls.map((c) => c.name)).toEqual(["lease", "log"]);
    expect(parsed.functions.find((f) => f.name === "Garage.close")!.calls.map((c) => c.name)).toEqual(["cleanup"]);
    // A call written without parentheses is a call.
    expect(parsed.functions.find((f) => f.name === "Garage.open")!.calls.map((c) => c.name)).toEqual(["Garage.reset"]);
  });

  it("reads a method called on a call through a name path as one statement (real-repo FP)", () => {
    const parsed = readLua("local function scan(path)\n  local cars = garage.Fleet.lookup(path):list(\"x\")\n  local id = squad[1].player.id\nend\n");
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions[0]!.calls.map((c) => c.name)).toEqual(["Fleet.lookup", "list"]);
  });

  it("reads LuaJIT's 64-bit integer literals (real-repo FP)", () => {
    expect(readLua("local GARAGE_BIT = lshift(0x01ULL, 61) + 12LL\n").syntaxErrors).toBe(0);
  });

  it("finds no function in a long comment or a string (real-repo FP)", () => {
    const parsed = readLua('--[[\nfunction Garage:retired(car)\nend\n--]]\nlocal note = { description = "the function name (or its ARN) to invoke" }\n');
    expect(parsed.functions).toEqual([]);
  });

  it("counts the syntax errors of a file the grammar cannot read (a Luau type annotation)", () => {
    expect(readLua("local function kickoff(team: string): boolean return true end\n").syntaxErrors).toBeGreaterThan(0);
  });
});
