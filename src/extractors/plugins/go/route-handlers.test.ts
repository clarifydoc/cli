import { describe, it, expect } from "vitest";
import { extractGoRoutes } from "./routes.js";

/**
 * A handler built by a call, Echo's `Add`, and the middleware Echo takes after an inline closure (real-repo FP):
 * `r.GET("/x", handlers.GetClubs(db))` names `db` as the handler, `e.Add("GET", "/x", h)` is no route, and what
 * follows a closure on Echo is dropped.
 */
const lines = (src: string) => src.split("\n");
const show = (src: string) => extractGoRoutes(lines(src)).map((r) => `${r.httpMethod} ${r.path} -> ${r.handler} [${r.middleware.join(", ")}]`);

describe("Go routes: a handler factory", () => {
  it("names the function that builds the handler, never a variable it is given", () => {
    expect(show(`
import (
	"database/sql"
	"github.com/gin-gonic/gin"
)

func routes(r *gin.Engine, db *sql.DB, cfg Config) {
	r.GET("/clubs", handlers.GetClubs(db))
	r.GET("/garages", garages.List(db, cfg))
	r.GET("/cars", AuthRequired(), handlers.GetCars(db))
	r.GET("/players", RequireLogin(handlers.GetPlayers(db)))
}
`)).toEqual([
      "GET /clubs -> handlers.GetClubs []",
      "GET /garages -> garages.List []",
      "GET /cars -> handlers.GetCars [AuthRequired()]",
      "GET /players -> handlers.GetPlayers [RequireLogin(handlers.GetPlayers(db))]",
    ]);
  });

  it("reads a factory whose name says login or admin, and a variable declared beside an error", () => {
    expect(show(`
import "github.com/gin-gonic/gin"

func main() {
	db, err := sql.Open("pgx", dsn)
	r := gin.Default()
	r.POST("/login", handlers.Login(db))
	r.GET("/admin/garages", admin.Garages(db))
}
`)).toEqual([
      "POST /login -> handlers.Login []",
      "GET /admin/garages -> admin.Garages []",
    ]);
  });

  it("keeps a wrapper's handler value, a conversion, and a function the file declares", () => {
    expect(show(`
import "github.com/gin-gonic/gin"

func routes(r *gin.Engine, db *sql.DB) {
	r.GET("/clubs", RequireLogin(listClubs))
	r.GET("/cars", gin.WrapF(http.HandlerFunc(listCars)))
	r.GET("/players", handlers.Players(h.ListPlayers))
}

func listClubs(c *gin.Context) {}
func listCars(w http.ResponseWriter, r *http.Request) {}
`)).toEqual([
      "GET /clubs -> listClubs [RequireLogin(listClubs)]",
      "GET /cars -> listCars []",
      "GET /players -> h.ListPlayers [handlers.Players(h.ListPlayers)]",
    ]);
  });
});

describe("Go routes: Echo's Add", () => {
  it("reads the verb from the first argument, on the router and on a group", () => {
    const routes = extractGoRoutes(lines(`
import (
	"net/http"

	"github.com/labstack/echo/v4"
)

func routes(e *echo.Echo) {
	e.Add("GET", "/players", listPlayers)
	g := e.Group("/api")
	g.Add(http.MethodPost, "/players", createPlayer, authRequired, logger)
	g.Add(echo.PUT, "/players/:id", updatePlayer)
	var wg sync.WaitGroup
	wg.Add(1)
}
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler} [${r.middleware.join(", ")}]`)).toEqual([
      "GET /players -> listPlayers []",
      "POST /api/players -> createPlayer [authRequired, logger]",
      "PUT /api/players/:id -> updatePlayer []",
    ]);
    expect(routes[1]!.auth?.policies).toEqual(["authRequired"]);
  });

  it("is no route on a receiver that is not Echo's", () => {
    expect(show(`
import "github.com/gin-gonic/gin"

func routes(r *gin.Engine, set *Set) {
	set.Add("GET", "/players", listPlayers)
}
`)).toEqual([]);
  });
});

describe("Go routes: Echo middleware after an inline closure", () => {
  it("is recorded in middleware and auth, on the close's line or the lines below it", () => {
    const routes = extractGoRoutes(lines(`
import "github.com/labstack/echo/v4"

func routes(e *echo.Echo) {
	g := e.Group("/api", requireSession)
	g.GET("/cars", func(c echo.Context) error {
		return c.String(200, "x")
	}, authRequired, logger)
	g.GET("/clubs", func(c echo.Context) error {
		return nil
	},
		jwtAuth,
		logger)
	g.GET("/players", func(c echo.Context) error { return nil })
}
`));
    expect(routes.map((r) => `${r.path} -> ${r.handler} [${r.middleware.join(", ")}]`)).toEqual([
      "/api/cars -> null [requireSession, authRequired, logger]",
      "/api/clubs -> null [requireSession, jwtAuth, logger]",
      "/api/players -> null [requireSession]",
    ]);
    expect(routes[0]!.auth?.policies).toEqual(["requireSession", "authRequired"]);
    expect(routes[1]!.auth?.schemes).toEqual(["jwtAuth"]);
  });
});
