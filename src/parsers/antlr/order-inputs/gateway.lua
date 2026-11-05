-- Match gateway: the same call shapes as keymap.lua, in other positions and orders.
local M = {}
local garage = require "league.garage"
local json = require("league.json")

local function check(car)
  assert(car, "no car")
  garage.cars[#garage.cars + 1] = car
  garage.cars[1]:wash():park()
  garage.entry.lane.gate(car):open()
  garage.entry.lane.gate "side"
  garage.entry.lane.gate { car }
  garage.entry.lane.gate(car)
  garage.entry.lane.slot = car
  garage.entry["lane"].slot = car
  local a = garage.entry.lane
  local f = garage.entry.lane
  (f or print)(a)
end

function M.handle(request, response)
  local body = json.decode(request.body)
  if not body then
    response:status(400):send "bad"
    return
  end
  local out = {}
  for key, value in pairs(body) do
    out[key] = tostring(value):upper()
  end
  local n = 0
  while n < 3 do n = n + 1 end
  repeat n = n - 1 until n <= 0
  response:send(json.encode(out))
end

M.limit = 10 // 3 + 2 ^ 3 .. "x"
M.mask = 0xff & 3 | 1 ~ 2 << 1 >> 1
M.long = [==[
a long ]] string
]==]
M.ok = not nil and true or false

return M
