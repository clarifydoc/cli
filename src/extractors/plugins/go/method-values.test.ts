import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { readGo } from "./antlr.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import "../../registry.js";

const SERVER = `package main

import (
	"fmt"
	"net/http"

	"example.com/league/handler"
)

type Server struct {
	handler *handler.Handler
	mux     *http.ServeMux
	name    string
}

type Player struct {
	Name string
}

func Wrap(f http.HandlerFunc) http.HandlerFunc { return f }

func (s *Server) Use(mw func(http.Handler) http.Handler) {}

// Name is a namesake of the field read below.
func Name() string { return "" }

func (s *Server) Routes() {
	s.mux.HandleFunc("/health", Wrap(s.handler.Health))
	s.Use(s.handler.Middleware)
	s.mux.HandleFunc("/clubs", s.handler.List)
	fmt.Println(s.name)
}

func later(h *handler.Handler, players []Player) {
	consume(h.Kickoff)
	for _, p := range players {
		consume(p.Name)
		consume(len(p.Name))
	}
	consume(handler.New)
	h.Substitute(nil, nil)
	consume(h.Substitute)
}

func consume(f interface{}) {}
`;

const HANDLER = `package handler

import "net/http"

type Handler struct{}

func New() *Handler { return &Handler{} }

func (h *Handler) Health(w http.ResponseWriter, r *http.Request)     {}
func (h *Handler) Middleware(next http.Handler) http.Handler         { return next }
func (h *Handler) List(w http.ResponseWriter, r *http.Request)       {}
func (h *Handler) Kickoff(w http.ResponseWriter, r *http.Request)    {}
func (h *Handler) Substitute(w http.ResponseWriter, r *http.Request) {}
`;

describe("Go method values handed on", () => {
  const passed = (name: string) => {
    const a = extractWithRegex(SERVER, "server.go", "go", undefined, readGo(SERVER));
    const fn = [...a.functions, ...a.classes.flatMap((c) => c.methods)].find((f) => f.name === name)!;
    return fn.calls.filter((c) => c.passed).map((c) => `${c.name}~${c.passed}`);
  };

  it("are passed arguments when the selector's head is a value the function declares", () => {
    // `handler.New` is a package's function, `len(p.Name)` a built-in reading a field, and `h.Substitute` a method
    // the function also calls.
    expect(passed("later")).toEqual(["h.Kickoff~argument", "p.Name~argument"]);
  });

  it("are no value handed on where a route registration names them as its handler", () => {
    expect(passed("Routes")).toEqual(["handler.Middleware~argument"]);
  });
});

describe("a method value handed on links as `passes`, only to a method", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-go-method-values-"));
    const files: Record<string, string> = { "go.mod": "module example.com/league\n\ngo 1.21\n", "server.go": SERVER, "handler/handler.go": HANDLER };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links each to the method its receiver's type declares, and a field read to nothing", () => {
    const passes = (summary.symbolLinks ?? []).filter((l) => l.relation === "passes")
      .map((l) => `${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`).sort();
    expect(passes).toEqual([
      "Server.Routes -> handler/handler.go::Handler.Middleware",
      "later -> handler/handler.go::Handler.Kickoff",
    ]);
    expect((summary.symbolLinks ?? []).some((l) => l.targetSymbol === "Name")).toBe(false);
  });
});
