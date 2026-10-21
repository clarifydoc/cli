import { describe, it, expect } from "vitest";
import { extractGoRoutes } from "./routes.js";
import { extractGoDataSources, normalizeRawStrings } from "./data-sources.js";

/**
 * Go route extraction previously covered only Go 1.22 "VERB /path" patterns
 * and ALL-CAPS gin/echo verbs with a named handler — chi/fiber (Title-case),
 * gorilla `.Methods(...)`, and every group/subrouter prefix were dropped, so
 * gin's `players.GET("", h)` behind two groups never joined a client call.
 */
const lines = (src: string) => src.split("\n");

describe("Go routes: gin/echo groups", () => {
  it("composes chained Group prefixes onto ALL-CAPS verbs", () => {
    const routes = extractGoRoutes(lines(`
r := gin.Default()
api := r.Group("/api")
v1 := api.Group("/v1")
v1.GET("/players", handlers.ListPlayers)
v1.POST("/players", handlers.CreatePlayer)
r.GET("/health", healthCheck)
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/v1/players",
      "POST /api/v1/players",
      "GET /health",
    ]);
    expect(routes[0]!.handler).toBe("handlers.ListPlayers");
  });
});

describe("Go routes: chi", () => {
  it("stacks Route(...) block prefixes and reads Title-case verbs", () => {
    const routes = extractGoRoutes(lines(`
r := chi.NewRouter()
r.Route("/api", func(r chi.Router) {
	r.Get("/health", health)
	r.Route("/players", func(r chi.Router) {
		r.Get("/", listPlayers)
		r.Post("/", createPlayer)
		r.Get("/{id}", getPlayer)
	})
})
r.Get("/version", version)
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/health",
      "GET /api/players",
      "POST /api/players",
      "GET /api/players/{id}",
      "GET /version",
    ]);
  });
});

describe("Go routes: gorilla mux", () => {
  it("expands .Methods(...) and applies PathPrefix subrouters", () => {
    const routes = extractGoRoutes(lines(`
r := mux.NewRouter()
s := r.PathPrefix("/api").Subrouter()
s.HandleFunc("/players", ListPlayers).Methods("GET")
s.HandleFunc("/players", CreatePlayer).Methods("POST", "PUT")
r.HandleFunc("/legacy", LegacyHandler)
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/players",
      "POST /api/players",
      "PUT /api/players",
      "null /legacy",
    ]);
    expect(routes[3]!.httpMethod).toBeNull(); // no Methods constraint = all verbs
  });

  it("reads a path under a deployment base (`baseUrl+\"/x\"`) and net/http method constants", () => {
    const routes = extractGoRoutes(lines(`
r := mux.NewRouter()
r.HandleFunc(baseUrl+"/", svc.homeHandler).Methods(http.MethodGet, http.MethodHead)
r.HandleFunc(baseUrl+"/garage/empty", svc.emptyGarageHandler).Methods(http.MethodPost)
r.HandleFunc(cfg.Base + "/part/{id}", svc.partHandler).Methods("GET")
r.HandleFunc(prefix(x)+"/no", h)
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).toEqual([
      "GET / svc.homeHandler",
      "HEAD / svc.homeHandler",
      "POST /garage/empty svc.emptyGarageHandler",
      "GET /part/{id} svc.partHandler",
    ]);
  });
});

describe("Go routes: net/http + fiber", () => {
  it("keeps Go 1.22 pattern strings and reads fiber Title verbs with groups", () => {
    const routes = extractGoRoutes(lines(`
mux.HandleFunc("GET /api/players/{id}", h.GetPlayer)
app := fiber.New()
grp := app.Group("/api")
grp.Get("/cars/:id", getCar)
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/players/{id}",
      "GET /api/cars/:id",
    ]);
  });
});

describe("Go routes: middleware and auth", () => {
  it("inherits r.Use / Group guards in line order and reads inline guards on the registration", () => {
    const routes = extractGoRoutes(lines(`
r := gin.Default()
r.Use(gin.Logger(), gin.Recovery())
r.GET("/health", handler.Health)
api := r.Group("/api")
api.Use(middleware.JWTAuth(secret))
api.GET("/me", handler.Me)
admin := r.Group("/admin", AuthRequired())
admin.DELETE("/parts/:id", handler.DeletePart)
admin.POST("/parts", RequireRole("admin", "editor"), handler.CreatePart)
`));
    const byPath = Object.fromEntries(routes.map((r) => [`${r.httpMethod} ${r.path}`, r]));
    expect(byPath["GET /health"]!.middleware).toEqual(["gin.Logger()", "gin.Recovery()"]);
    expect(byPath["GET /health"]!.auth).toBeUndefined(); // plain middleware says nothing about auth
    expect(byPath["GET /api/me"]!.middleware).toEqual(["gin.Logger()", "gin.Recovery()", "middleware.JWTAuth(secret)"]);
    expect(byPath["GET /api/me"]!.auth).toEqual({
      policies: [], roles: [], schemes: ["middleware.JWTAuth"], anonymous: false, inherited: true,
    });
    expect(byPath["DELETE /admin/parts/:id"]!.auth).toEqual({
      policies: ["AuthRequired"], roles: [], schemes: [], anonymous: false, inherited: true,
    });
    expect(byPath["DELETE /admin/parts/:id"]!.handler).toBe("handler.DeletePart");
    const post = byPath["POST /admin/parts"]!;
    expect(post.handler).toBe("handler.CreatePart");
    expect(post.middleware).toEqual(["gin.Logger()", "gin.Recovery()", "AuthRequired()", 'RequireRole("admin", "editor")']);
    expect(post.auth).toEqual({
      policies: ["AuthRequired"], roles: ["admin", "editor"], schemes: [], anonymous: false, inherited: false,
    });
  });

  it("scopes chi block Use to the block and reads With(...) and handler wrappers", () => {
    const routes = extractGoRoutes(lines(`
r := chi.NewRouter()
r.Use(middleware.Logger)
r.Route("/api", func(r chi.Router) {
	r.Use(jwtauth.Verifier(tokenAuth), jwtauth.Authenticator)
	r.Get("/me", me)
	r.With(RequireAdmin).Delete("/players/{id}", deletePlayer)
})
r.Get("/version", version)
r.Method("GET", "/metrics", promhttp.Handler())
mux.Handle("GET /secure", auth(http.HandlerFunc(secure)))
`));
    const byPath = Object.fromEntries(routes.map((r) => [`${r.httpMethod} ${r.path}`, r]));
    expect(byPath["GET /api/me"]!.middleware).toEqual(["middleware.Logger", "jwtauth.Verifier(tokenAuth)", "jwtauth.Authenticator"]);
    expect(byPath["GET /api/me"]!.auth!.schemes).toEqual(["jwtauth.Verifier", "jwtauth.Authenticator"]);
    expect(byPath["DELETE /api/players/{id}"]!.auth).toEqual({
      policies: ["RequireAdmin"], roles: [], schemes: ["jwtauth.Verifier", "jwtauth.Authenticator"], anonymous: false, inherited: false,
    });
    // Block-scoped Use does not leak past the block.
    expect(byPath["GET /version"]!.middleware).toEqual(["middleware.Logger"]);
    expect(byPath["GET /version"]!.auth).toBeUndefined();
    expect(byPath["GET /metrics"]!.handler).toBeNull(); // promhttp.Handler() is a value, not a name
    expect(byPath["GET /secure"]!.handler).toBe("secure");
    expect(byPath["GET /secure"]!.middleware).toEqual(["auth(http.HandlerFunc(secure))"]);
    expect(byPath["GET /secure"]!.auth!.policies).toEqual(["auth"]);
  });

  it("does not mistake single-argument Get calls or client requests for routes", () => {
    const routes = extractGoRoutes(lines(`
v := c.Get("player")
resp, _ := http.Get("/internal/cars")
q := r.URL.Query().Get("q")
`));
    expect(routes).toEqual([]);
  });
});

describe("Go data sources", () => {
  it("normalizes backtick raw SQL into per-line quoted fragments", () => {
    const norm = normalizeRawStrings('q := `SELECT id\nFROM players\nWHERE active = 1`');
    expect(norm.split("\n")).toEqual([
      'q := "SELECT id"',
      '"FROM players"',
      '"WHERE active = 1"',
    ]);
  });

  it("extracts the table from multi-line backtick SQL (entity set)", () => {
    const s = extractGoDataSources(lines(`
func (r *Repo) List(ctx context.Context) ([]Player, error) {
	rows, err := r.db.Query(\`
		SELECT id, name, email
		FROM players
		WHERE active = 1\`)
	return scan(rows), err
}
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "players")).toBe(true);
  });

  it("captures GORM verbs (entity from struct literal), HTTP clients, env and MQ", () => {
    const s = extractGoDataSources(lines(`
db.Model(&Player{}).Where("age > ?", 18).Find(&players)
resp, _ := http.Get("https://api.example.com/items")
req, _ := http.NewRequest("POST", "/internal/cars", body)
token := os.Getenv("API_TOKEN")
ch.PublishWithContext(ctx, "cars", key, false, false, msg)
msgs, _ := ch.Consume("cars-queue", "", true, false, false, false, nil)
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "Player")).toBe(true);
    expect(s.some((d) => d.kind === "api-call" && d.name === "GET" && d.target === "https://api.example.com/items")).toBe(true);
    expect(s.some((d) => d.kind === "api-call" && d.name === "POST" && d.target === "/internal/cars")).toBe(true);
    expect(s.some((d) => d.kind === "env" && d.target === "API_TOKEN")).toBe(true);
    expect(s.some((d) => d.kind === "queue-publish" && d.target === "cars")).toBe(true);
    expect(s.some((d) => d.kind === "queue-consume" && d.target === "cars-queue")).toBe(true);
  });

  it("does not misread prose or non-DB receivers", () => {
    const s = extractGoDataSources(lines(`
log.Println("Select a file from the list")
cache.Find(&results)
`));
    expect(s.filter((d) => d.kind === "database")).toEqual([]);
  });
});

describe("Go routes: inline closures", () => {
  it("anchors a closure-handled route at the function declaring it", () => {
    const routes = extractGoRoutes(lines(`
func GetAlbum(router *gin.RouterGroup) {
	router.GET("/albums/:uid", func(c *gin.Context) {
		a, err := query.AlbumByUID(c.Param("uid"))
		c.JSON(http.StatusOK, a)
	})
	router.POST("/albums", CreateAlbum)
}
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /albums/:uid -> GetAlbum",
      "POST /albums -> CreateAlbum",
    ]);
  });
});
