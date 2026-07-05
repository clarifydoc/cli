import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Go module recognition (module-path names). Plugin-owned. */
export const goPackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["github.com/gin-gonic/gin"], category: "framework", framework: { id: "gin", name: "Gin" } },
  { names: ["github.com/labstack/echo", "github.com/labstack/echo/v4"], category: "framework", framework: { id: "echo", name: "Echo" } },
  { names: ["github.com/gofiber/fiber", "github.com/gofiber/fiber/v2"], category: "framework", framework: { id: "fiber", name: "Fiber" } },
  { names: ["github.com/go-chi/chi", "github.com/go-chi/chi/v5"], category: "framework", framework: { id: "chi", name: "chi" } },
  { names: ["github.com/gorilla/mux"], category: "framework", framework: { id: "gorilla", name: "Gorilla Mux" } },
  { names: ["github.com/beego/beego", "github.com/astaxie/beego"], category: "framework", framework: { id: "beego", name: "Beego" } },
  // ── ORM ──
  { names: ["gorm.io/gorm", "entgo.io/ent", "github.com/jmoiron/sqlx"], category: "orm" },
  // ── Database drivers ──
  { names: ["github.com/lib/pq", "github.com/go-sql-driver/mysql", "go.mongodb.org/mongo-driver"], category: "database" },
  // ── gRPC ──
  { names: ["google.golang.org/grpc"], category: "grpc" },
  // ── Logging ──
  { names: ["logrus", "go.uber.org/zap"], category: "logging" },
  // ── Utility / CLI ──
  { names: ["github.com/spf13/cobra", "github.com/spf13/viper", "github.com/google/uuid"], category: "util" },

  // ── Family patterns ──
  { match: /^github\.com\/aws\/aws-sdk-go/, category: "cloud" },
  { match: /^github\.com\/prometheus\//, category: "logging" },
  { match: /^github\.com\/(stretchr\/testify|onsi\/(ginkgo|gomega))/, category: "testing" },
  { match: /^github\.com\/sirupsen\/logrus/, category: "logging" },
];
