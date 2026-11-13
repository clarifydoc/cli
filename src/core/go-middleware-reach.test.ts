import { describe, it, expect } from "vitest";
import { runCarets } from "./caret-testkit.js";

const GO_MOD = "module example.com/league\n\ngo 1.21\n";

const HANDLERS = `package handlers

import (
\t"github.com/gin-gonic/gin"
\t"github.com/labstack/echo/v4"
)

func ListClubs(c *gin.Context)         { c.JSON(200, "x") }
func Ping(c *gin.Context)              { c.JSON(200, "pong") }
func ListStaff(c *gin.Context)         { c.JSON(200, "x") }
func ListCars(c echo.Context) error    { return nil }
func ListGarages(c echo.Context) error { return nil }
`;

const AUTH = `package auth

import (
\t"github.com/gin-gonic/gin"
\t"gorm.io/gorm"
)

type Session struct{ ID uint }

func SessionRequired(db *gorm.DB) gin.HandlerFunc {
\treturn func(c *gin.Context) {
\t\tvar s Session
\t\tdb.Table("sessions").Where("token = ?", c.GetHeader("X")).First(&s)
\t\tc.Next()
\t}
}

func StaffOnly(db *gorm.DB) gin.HandlerFunc {
\treturn func(c *gin.Context) {
\t\tdb.Table("staff_members").First(nil)
\t\tc.Next()
\t}
}
`;

// Namesakes in another package: the registration imports "auth", never this one, and gin.Logger is the library's.
const DECOY_AUTH = `package decoy

import "gorm.io/gorm"

func SessionRequired(db *gorm.DB) func() {
\treturn func() { db.Table("decoy_table").Find(nil) }
}

func Logger(db *gorm.DB) { db.Table("log_lines").Find(nil) }
`;

const MAIN = `package main

import (
\t"example.com/league/auth"
\t"example.com/league/handlers"
\t"github.com/gin-gonic/gin"
\t"github.com/labstack/echo/v4"
\t"gorm.io/gorm"
)

func setup(r *gin.Engine, db *gorm.DB) {
\tapi := r.Group("/api", gin.Logger(), auth.SessionRequired(db))
\tapi.GET("/clubs", handlers.ListClubs)
\tapi.GET("/inline", func(c *gin.Context) { db.Table("inline_rows").Find(nil) })
\topen := r.Group("/public")
\topen.GET("/ping", handlers.Ping)

\tadm := r.Group("/admin")
\tadm.Use(auth.StaffOnly(db))
\tadm.GET("/staff", handlers.ListStaff)
}

func echoSetup(e *echo.Echo, db *gorm.DB) {
\tg := e.Group("/cars", auth.SessionRequired(db))
\tg.GET("", handlers.ListCars)
\te.GET("/garage", handlers.ListGarages)
}
`;

describe("Go middleware reach (gin Group / Use, Echo Group)", () => {
  it("joins what a middleware reads to the routes it guards, never to another group's", async () => {
    const { analysis } = await runCarets({
      "go.mod": GO_MOD,
      "main.go": MAIN,
      "handlers/h.go": HANDLERS,
      "auth/auth.go": AUTH,
      "decoy/decoy.go": DECOY_AUTH,
    });
    const flows = (analysis.dataFlows ?? []).map((f) => `${f.entryLabel} ${f.effect} ${f.resource}${f.viaMiddleware ? " (middleware)" : ""}`).sort();
    expect(flows).toEqual([
      "GET /admin/staff db-read staff_members (middleware)",
      "GET /api/clubs db-read sessions (middleware)",
      "GET /api/inline db-read inline_rows",
      "GET /api/inline db-read sessions (middleware)",
      "GET /cars db-read sessions (middleware)",
    ]);
  });
});

const CLUB_MIGRATION = `package v2

import (
\t"context"

\t"github.com/danielgtaylor/huma/v2"
\t"gorm.io/gorm"
)

func registerClubMigration(api huma.API, db *gorm.DB, name string) {
\thuma.Register(api, huma.Operation{
\t\tMethod: "POST",
\t\tPath:   "/migration/{name}/migrate",
\t}, func(ctx context.Context, in *struct{}) (*struct{}, error) {
\t\tdb.Table("club_imports").Create(in)
\t\treturn nil, nil
\t})
}
`;

const CAR_MIGRATION = `package v2

import (
\t"context"

\t"github.com/danielgtaylor/huma/v2"
\t"gorm.io/gorm"
)

func registerCarMigration(api huma.API, db *gorm.DB, name string) {
\thuma.Register(api, huma.Operation{
\t\tMethod: "POST",
\t\tPath:   "/migration/" + name + "/migrate",
\t}, func(ctx context.Context, in *struct{}) (*struct{}, error) {
\t\tdb.Table("car_imports").Create(in)
\t\treturn nil, nil
\t})
}
`;

describe("Go Huma registrars declaring the same templated path", () => {
  it("keeps each registrar's row, and each row reaches only its own table", async () => {
    const { analysis } = await runCarets({
      "go.mod": GO_MOD,
      "v2/club_migration.go": CLUB_MIGRATION,
      "v2/car_migration.go": CAR_MIGRATION,
    });
    const rows = (analysis.routeMap ?? []).map((r) => `${r.httpMethod} ${r.path} ${r.registrar}`).sort();
    expect(rows).toEqual([
      "POST /migration/{name}/migrate registerCarMigration",
      "POST /migration/{name}/migrate registerClubMigration",
    ]);
    const byFile = new Map<string, string[]>();
    for (const f of analysis.dataFlows ?? []) (byFile.get(f.entryFile) ?? byFile.set(f.entryFile, []).get(f.entryFile)!).push(f.resource);
    expect([...byFile.entries()].map(([file, tables]) => `${file.split("/").pop()}: ${tables.join(",")}`).sort()).toEqual([
      "car_migration.go: car_imports",
      "club_migration.go: club_imports",
    ]);
  });
});
