import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import "../../registry.js";
import { restoreTypedReceiverCalls } from "../../../core/typed-receivers.js";
import { luaTables } from "./tables.js";
import { readLua } from "./antlr.js";

describe("Lua one-line functions on the regex reading", () => {
  it("takes the calls of a body written on the declaration line", () => {
    const a = extractWithRegex(`local M = {}
function M.kick() return 1 end
function M:pass(x) return M.kick() end
local function helper() return M.kick() end
function M.run()
  return helper()
end
return M
`, "m.lua", "lua");
    const callsOf = (n: string) => a.functions.find((f) => f.name === n)?.calls.map((c) => c.name);
    expect(callsOf("M.kick")).toEqual([]);
    expect(callsOf("M:pass")).toEqual(["M.kick"]);
    expect(callsOf("helper")).toEqual(["M.kick"]);
    expect(callsOf("M.run")).toEqual(["helper"]);
  });
});

describe("Lua scripts", () => {
  it("records a script's own statements as <setup>, never words in a long comment or string or a word operator (real-repo FP)", () => {
    const a = extractWithRegex(`--[[
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
`, "gate.lua", "lua");
    const setup = a.functions.find((f) => f.name === "<setup>");
    expect(setup?.calls.map((c) => c.name)).toEqual(["os.getenv", "stadium.authenticate", "fail"]);
    expect(a.functions.find((f) => f.name === "fail")?.calls.map((c) => c.name)).toEqual(["ngx.log", "ngx.redirect"]);
  });
});

describe("Lua calls on a require", () => {
  it("names a module function called on the require that loads it", () => {
    const a = extractWithRegex(`local res = require("league.auth").authenticate(opts, target)
local hex = require("league.codec").to_hex(id)
`, "access.lua", "lua");
    const setup = a.functions.find((f) => f.name === "<setup>");
    expect(setup?.calls.map((c) => c.name)).toEqual(expect.arrayContaining(["auth.authenticate", "codec.to_hex"]));
  });
});

describe("Lua tables as classes", () => {
  const read = (source: string, path: string) => {
    const a = extractWithRegex(source, path, "lua", undefined, readLua(source));
    luaTables(a, source);
    restoreTypedReceiverCalls(a);
    return a;
  };

  it("turns the functions a table stores into its methods and keeps a receiver on `obj:method()`", () => {
    const a = read(`local Club = {}
Club.__index = Club
function Club.new(name)
  return setmetatable({ name = name }, Club)
end
function Club:warmup()
  return 1
end
function Club:train()
  self:warmup()
  local mate = Club.new("b")
  mate:warmup()
end
return Club
`, "club.lua");
    const club = a.classes.find((c) => c.name === "Club");
    expect(club?.methods.map((m) => m.name)).toEqual(["new", "warmup", "train"]);
    expect(club?.isExported).toBe(true);
    expect(a.functions.some((f) => f.name.startsWith("Club"))).toBe(false);
    const train = club!.methods.find((m) => m.name === "train")!;
    expect(train.calls.map((c) => c.name)).toEqual(expect.arrayContaining(["self.warmup", "mate.warmup", "Club.new"]));
    expect(train.localTypes).toEqual([{ name: "mate", type: "Club" }]);
  });

  it("makes `setmetatable(Sub, { __index = Base })` the base, and a `local r = require(...)` a namespace import", () => {
    const a = read(`local Base = require("base")
local Reserve = {}
setmetatable(Reserve, { __index = Base })
function Reserve:bench() end
local Base2 = {}
function Base2:play() end
setmetatable(Reserve, { __index = Base2 })
`, "reserve.lua");
    expect(a.imports[0]).toMatchObject({ source: "base", specifiers: ["Base"], isNamespace: true });
    expect(a.classes.find((c) => c.name === "Reserve")?.extends).toBe("Base");
  });

  it("reads Roblox `require(script.Parent.X)` as a relative import", () => {
    const a = extractWithRegex(`local Ball = require(script.Parent.Ball)
local Pitch = require(script.Parent.Parent.Pitch)
`, "Part.server.lua", "lua");
    expect(a.imports.map((i) => [i.source, i.specifiers])).toEqual([["./Ball", ["Ball"]], ["../Pitch", ["Pitch"]]]);
  });
});
