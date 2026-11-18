import { describe, it, expect } from "vitest";
import { runCarets } from "./caret-testkit.js";

const DB = `const { Pool } = require("pg");
module.exports = new Pool();
`;

const AUTH = `const db = require("./db");

async function requireTicket(request, reply) {
  await db.query("SELECT * FROM match_tickets WHERE token = $1", [request.headers.authorization]);
}

async function loadStadium(request, reply) {
  request.stadium = await db.query("SELECT * FROM stadiums WHERE id = $1", [request.params.id]);
}

module.exports = { requireTicket, loadStadium };
`;

const DECOY = `const db = require("./db");

async function requireTicket(request, reply) {
  await db.query("SELECT * FROM decoy_gate");
}

module.exports = { requireTicket };
`;

const SERVER = `const fastify = require("fastify");
const { requireTicket, loadStadium } = require("./auth");

const app = fastify();

async function leagueRoutes(server) {
  server.get("/ping", async () => "pong");
  server.addHook("preHandler", requireTicket);
  server.get("/stadiums/:id", { preHandler: loadStadium }, async () => ({}));
}

app.register(leagueRoutes, { prefix: "/api" });
module.exports = app;
`;

describe("Fastify addHook middleware reach", () => {
  it("joins what scoped hooks and route preHandlers read to the route, never a namesake", async () => {
    const { analysis } = await runCarets({
      "package.json": '{"name":"league","dependencies":{"fastify":"4.0.0","pg":"8.0.0"}}',
      "src/db.js": DB,
      "src/auth.js": AUTH,
      "src/decoy.js": DECOY,
      "src/server.js": SERVER,
    });
    const flows = (analysis.dataFlows ?? []).map((f) => `${f.entryLabel} ${f.resource}${f.viaMiddleware ? " (middleware)" : ""}`).sort();
    expect(flows).toEqual([
      "GET /api/stadiums/:id match_tickets (middleware)",
      "GET /api/stadiums/:id stadiums (middleware)",
    ]);
  });
});