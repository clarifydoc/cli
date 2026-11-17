import { describe, it, expect } from "vitest";
import { runCarets } from "./caret-testkit.js";

const DB = `const { Pool } = require("pg");
module.exports = new Pool();
`;

const AUTH = `const db = require("./db");

async function requireSession(req, res, next) {
  await db.query("SELECT * FROM sessions WHERE token = $1", [req.headers.token]);
  next();
}

async function loadClub(req, res, next) {
  req.club = await db.query("SELECT * FROM clubs WHERE id = $1", [req.params.id]);
  next();
}

async function loadCar(req, res, next) {
  req.car = await db.query("SELECT * FROM cars WHERE id = $1", [req.params.id]);
  next();
}

module.exports = { requireSession, loadClub, loadCar };
`;

// A namesake of a middleware the router never imports.
const DECOY = `const db = require("./db");

async function requireSession(req, res, next) {
  await db.query("SELECT * FROM decoy_tokens");
  next();
}

module.exports = { requireSession };
`;

const ROUTES = `const express = require("express");
const { requireSession, loadClub } = require("./auth");
const auth = require("./auth");
const router = express.Router();

router.get("/early", (req, res) => res.json("early"));
router.use(requireSession);
router.get("/clubs/:id", loadClub, (req, res) => res.json(req.club));
router.get("/ping", (req, res) => res.json("pong"));
router.get("/cars/:id", [auth.loadCar], (req, res) => res.json(req.car));

module.exports = router;
`;

const APP = `const express = require("express");
const routes = require("./routes");
const app = express();
app.use("/api", routes);
`;

describe("Express middleware reach", () => {
  it("joins what router-level and per-route middleware read to the route, never a namesake's", async () => {
    const { analysis } = await runCarets({
      "package.json": '{"name":"league","dependencies":{"express":"4.18.0","pg":"8.0.0"}}',
      "src/db.js": DB,
      "src/auth.js": AUTH,
      "src/decoy.js": DECOY,
      "src/routes.js": ROUTES,
      "src/app.js": APP,
    });
    const flows = (analysis.dataFlows ?? []).map((f) => `${f.entryLabel} ${f.resource}${f.viaMiddleware ? " (middleware)" : ""}`).sort();
    expect(flows).toEqual([
      "GET /api/cars/:id cars (middleware)",
      "GET /api/cars/:id sessions (middleware)",
      "GET /api/clubs/:id clubs (middleware)",
      "GET /api/clubs/:id sessions (middleware)",
      "GET /api/ping sessions (middleware)",
    ]);
  });
});
