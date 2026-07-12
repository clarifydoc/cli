import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasGoMod } from "../shared/project-info-queries.js";

/** Go framework rules — web routers and ORMs via go.mod. */
export const goFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "gin",
    name: "Gin",
    check: (info) => hasGoMod(info, "github.com/gin-gonic/gin"),
    detectedVia: "go.mod dependency",
  },
  {
    id: "echo",
    name: "Echo",
    check: (info) => hasGoMod(info, "github.com/labstack/echo"),
    detectedVia: "go.mod dependency",
  },
  {
    id: "chi",
    name: "chi",
    check: (info) => hasGoMod(info, "github.com/go-chi/chi"),
    detectedVia: "go.mod dependency",
  },
  {
    id: "fiber",
    name: "Fiber",
    check: (info) => hasGoMod(info, "github.com/gofiber/fiber"),
    detectedVia: "go.mod dependency",
  },
  {
    id: "gorilla-mux",
    name: "gorilla/mux",
    check: (info) => hasGoMod(info, "github.com/gorilla/mux"),
    detectedVia: "go.mod dependency",
  },
  // ORMs
  {
    id: "gorm",
    name: "GORM",
    check: (info) => hasGoMod(info, "gorm.io/gorm"),
    detectedVia: "go.mod dependency",
  },
  {
    id: "sqlx",
    name: "sqlx",
    check: (info) => hasGoMod(info, "github.com/jmoiron/sqlx"),
    detectedVia: "go.mod dependency",
  },
  {
    id: "ent",
    name: "Ent",
    check: (info) => hasGoMod(info, "entgo.io/ent"),
    detectedVia: "go.mod dependency",
  },
];
