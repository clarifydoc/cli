import { describe, it, expect } from "vitest";
import { extractGoRoutes } from "./routes.js";

const names = (src: string) => extractGoRoutes(src.split("\n")).map((r) => `${r.httpMethod} ${r.path} [${(r.middlewareCalls ?? []).join(", ")}]`);

describe("Go routes name the functions their middleware calls", () => {
  it("gin group arguments and Use reach only the routes of their own group", () => {
    expect(names(`package main

func setup(r *gin.Engine, db *gorm.DB) {
\tapi := r.Group("/api", auth.SessionRequired(db), gin.Logger())
\tapi.GET("/clubs", handlers.ListClubs)
\topen := r.Group("/public")
\topen.GET("/ping", handlers.Ping)
\tadm := r.Group("/admin")
\tadm.Use(authStaff)
\tadm.GET("/staff", handlers.ListStaff)
}`)).toEqual([
      "GET /api/clubs [auth.SessionRequired, gin.Logger]",
      "GET /public/ping []",
      "GET /admin/staff [authStaff]",
    ]);
  });

  it("chi With and Use, Echo's trailing middleware, and no inline closure or the handler's own name", () => {
    expect(names(`package main

func setup(r chi.Router) {
\tr.With(auth.Session).Get("/clubs", ListClubs)
\tr.Group(func(r chi.Router) {
\t\tr.Use(staffOnly)
\t\tr.Get("/staff", ListStaff)
\t})
\tr.Use(func(next http.Handler) http.Handler { return next })
\tr.Get("/ping", Ping)
}`)).toEqual([
      "GET /clubs [auth.Session]",
      "GET /staff [staffOnly]",
      "GET /ping []",
    ]);
  });
});
