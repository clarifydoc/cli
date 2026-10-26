import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import "../../registry.js";

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
