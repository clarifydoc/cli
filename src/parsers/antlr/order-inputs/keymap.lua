-- Club roster helpers: call statements, string and table calls, method chains.
local Club = {}
Club.__index = Club

local gio = { File = {} }

function Club.new(name)
  return setmetatable({ name = name, players = {} }, Club)
end

function Club:add(player)
  self.players[#self.players + 1] = player
  return self
end

function gio.File.open(path)
  return { read = function(self) return path end }
end

local function describe(club)
  gio.File.open(club.name):read()
  club:add("Ann"):add("Bob")
  print "kickoff"
  print [[whistle]]
  require "league.table"
  require("league.cup").start { rounds = 3 }
  local t = club.players[1]
  t.name = "Cara"
  club.players[2].shirt = 7
  club.a.b.c(1)
  club.a.b.c(1):m()
  club.a["b"].c "x"
  club.a.b.c { 1 }
  club.a.b.c = 2
  ;(club.f or print)(1)
  local n = #club.players
  if n > 2 and n < 9 then
    return string.format("%d", n)
  elseif n == 0 then
    goto done
  end
  for i, p in ipairs(club.players) do
    print(i, p)
  end
  ::done::
  return nil
end

-- A long comment follows
--[==[ multi
line ]==]
local a = {
  f = function(x) return x end,
  ["key"] = 1,
  2, 3;
}
return { Club = Club, describe = describe, a = a }
