import { describe, it, expect } from "vitest";
import { extractGoRoutes } from "./routes.js";
import { extractGoDataSources, normalizeRawStrings } from "./data-sources.js";

/**
 * Go route extraction previously covered only Go 1.22 "VERB /path" patterns
 * and ALL-CAPS gin/echo verbs with a named handler — chi/fiber (Title-case),
 * gorilla `.Methods(...)`, and every group/subrouter prefix were dropped, so
 * gin's `users.GET("", h)` behind two groups never joined a client call.
 */
const lines = (src: string) => src.split("\n");

describe("Go routes: gin/echo groups", () => {
  it("composes chained Group prefixes onto ALL-CAPS verbs", () => {
    const routes = extractGoRoutes(lines(`
r := gin.Default()
api := r.Group("/api")
v1 := api.Group("/v1")
v1.GET("/users", handlers.ListUsers)
v1.POST("/users", handlers.CreateUser)
r.GET("/health", healthCheck)
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/v1/users",
      "POST /api/v1/users",
      "GET /health",
    ]);
    expect(routes[0]!.handler).toBe("handlers.ListUsers");
  });
});

describe("Go routes: chi", () => {
  it("stacks Route(...) block prefixes and reads Title-case verbs", () => {
    const routes = extractGoRoutes(lines(`
r := chi.NewRouter()
r.Route("/api", func(r chi.Router) {
	r.Get("/health", health)
	r.Route("/users", func(r chi.Router) {
		r.Get("/", listUsers)
		r.Post("/", createUser)
		r.Get("/{id}", getUser)
	})
})
r.Get("/version", version)
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/health",
      "GET /api/users",
      "POST /api/users",
      "GET /api/users/{id}",
      "GET /version",
    ]);
  });
});

describe("Go routes: gorilla mux", () => {
  it("expands .Methods(...) and applies PathPrefix subrouters", () => {
    const routes = extractGoRoutes(lines(`
r := mux.NewRouter()
s := r.PathPrefix("/api").Subrouter()
s.HandleFunc("/users", ListUsers).Methods("GET")
s.HandleFunc("/users", CreateUser).Methods("POST", "PUT")
r.HandleFunc("/legacy", LegacyHandler)
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/users",
      "POST /api/users",
      "PUT /api/users",
      "null /legacy".replace("null", "null"),
    ]);
    expect(routes[3]!.httpMethod).toBeNull(); // no Methods constraint = all verbs
  });
});

describe("Go routes: net/http + fiber", () => {
  it("keeps Go 1.22 pattern strings and reads fiber Title verbs with groups", () => {
    const routes = extractGoRoutes(lines(`
mux.HandleFunc("GET /api/users/{id}", h.GetUser)
app := fiber.New()
grp := app.Group("/api")
grp.Get("/orders/:id", getOrder)
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/users/{id}",
      "GET /api/orders/:id",
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
admin.DELETE("/products/:id", handler.DeleteProduct)
admin.POST("/products", RequireRole("admin", "editor"), handler.CreateProduct)
`));
    const byPath = Object.fromEntries(routes.map((r) => [`${r.httpMethod} ${r.path}`, r]));
    expect(byPath["GET /health"]!.middleware).toEqual(["gin.Logger()", "gin.Recovery()"]);
    expect(byPath["GET /health"]!.auth).toBeUndefined(); // plain middleware says nothing about auth
    expect(byPath["GET /api/me"]!.middleware).toEqual(["gin.Logger()", "gin.Recovery()", "middleware.JWTAuth(secret)"]);
    expect(byPath["GET /api/me"]!.auth).toEqual({
      policies: [], roles: [], schemes: ["middleware.JWTAuth"], anonymous: false, inherited: true,
    });
    expect(byPath["DELETE /admin/products/:id"]!.auth).toEqual({
      policies: ["AuthRequired"], roles: [], schemes: [], anonymous: false, inherited: true,
    });
    expect(byPath["DELETE /admin/products/:id"]!.handler).toBe("handler.DeleteProduct");
    const post = byPath["POST /admin/products"]!;
    expect(post.handler).toBe("handler.CreateProduct");
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
	r.With(RequireAdmin).Delete("/users/{id}", deleteUser)
})
r.Get("/version", version)
r.Method("GET", "/metrics", promhttp.Handler())
mux.Handle("GET /secure", auth(http.HandlerFunc(secure)))
`));
    const byPath = Object.fromEntries(routes.map((r) => [`${r.httpMethod} ${r.path}`, r]));
    expect(byPath["GET /api/me"]!.middleware).toEqual(["middleware.Logger", "jwtauth.Verifier(tokenAuth)", "jwtauth.Authenticator"]);
    expect(byPath["GET /api/me"]!.auth!.schemes).toEqual(["jwtauth.Verifier", "jwtauth.Authenticator"]);
    expect(byPath["DELETE /api/users/{id}"]!.auth).toEqual({
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
v := c.Get("user")
resp, _ := http.Get("/internal/orders")
q := r.URL.Query().Get("q")
`));
    expect(routes).toEqual([]);
  });
});

describe("Go data sources", () => {
  it("normalizes backtick raw SQL into per-line quoted fragments", () => {
    const norm = normalizeRawStrings('q := `SELECT id\nFROM users\nWHERE active = 1`');
    expect(norm.split("\n")).toEqual([
      'q := "SELECT id"',
      '"FROM users"',
      '"WHERE active = 1"',
    ]);
  });

  it("extracts the table from multi-line backtick SQL (entity set)", () => {
    const s = extractGoDataSources(lines(`
func (r *Repo) List(ctx context.Context) ([]User, error) {
	rows, err := r.db.Query(\`
		SELECT id, name, email
		FROM users
		WHERE active = 1\`)
	return scan(rows), err
}
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "users")).toBe(true);
  });

  it("captures GORM verbs (entity from struct literal), HTTP clients, env and MQ", () => {
    const s = extractGoDataSources(lines(`
db.Model(&User{}).Where("age > ?", 18).Find(&users)
resp, _ := http.Get("https://api.example.com/items")
req, _ := http.NewRequest("POST", "/internal/orders", body)
token := os.Getenv("API_TOKEN")
ch.PublishWithContext(ctx, "orders", key, false, false, msg)
msgs, _ := ch.Consume("orders-queue", "", true, false, false, false, nil)
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "User")).toBe(true);
    expect(s.some((d) => d.kind === "api-call" && d.name === "GET" && d.target === "https://api.example.com/items")).toBe(true);
    expect(s.some((d) => d.kind === "api-call" && d.name === "POST" && d.target === "/internal/orders")).toBe(true);
    expect(s.some((d) => d.kind === "env" && d.target === "API_TOKEN")).toBe(true);
    expect(s.some((d) => d.kind === "queue-publish" && d.target === "orders")).toBe(true);
    expect(s.some((d) => d.kind === "queue-consume" && d.target === "orders-queue")).toBe(true);
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
