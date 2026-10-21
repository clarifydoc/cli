import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor } from "../../registry.js";
import type { FileAnalysis, Language } from "../../../types/analysis.js";

/** Through the plugin's preprocess, as the analyzer runs it. */
function analyze(src: string, path: string, language: Language): FileAnalysis {
  const pre = pluginFor(language)!.preprocess!(src, path);
  const p = pre && "sourceText" in pre ? pre : null;
  const analysis = extractWithRegex(p?.sourceText ?? src, path, language);
  p?.postExtract?.(analysis, src);
  return analysis;
}
const fns = (a: FileAnalysis) => a.functions.map((f) => [f.name, f.params.map((p) => p.name + (p.type ? `:${p.type}` : "") + (p.defaultValue ? `=${p.defaultValue}` : "")), f.calls.map((c) => c.name)]);

describe("Racket", () => {
  const a = analyze([
    "#lang racket/base",
    '(require web-server/servlet web-server/dispatch db "db.rkt" (only-in "crm.rkt" notify-closed))',
    "(provide start (struct-out car))",
    "#| block comment (not-a-call) |#",
    "(struct car (id total) #:transparent)",
    "(define car-repo%",
    "  (class object%",
    "    (init-field conn)",
    "    (define/public (find id) (query-row conn \"SELECT id, total FROM cars WHERE id = $1\" id))",
    "    (super-new)))",
    "(define (close-car req id #:force [force #f])",
    "  (when (and id (not force)) (mark-closed! id))",
    "  (send repo save id)",
    "  (notify-closed id))",
    "(define-values (app-dispatch app-url)",
    "  (dispatch-rules",
    '   [("cars" (integer-arg)) show-car]',
    '   [("cars" (integer-arg) "close") #:method "post" close-car]))',
    "(define (start req) (app-dispatch req))",
    "(module+ test (check-equal? (start #f) 1))",
    "(module+ main (serve/servlet start))",
  ].join("\n"), "src/app.rkt", "racket");

  it("reads functions, structs and classes", () => {
    expect(fns(a)).toEqual([
      ["<setup>", [], ["serve/servlet"]],
      ["close-car", ["req", "id", "force=#f"], ["mark-closed!", "repo.save", "notify-closed"]],
      ["start", ["req"], ["app-dispatch"]],
    ]);
    expect(a.classes.map((c) => [c.name, c.extends, c.properties.map((p) => p.name), c.methods.map((m) => m.name)])).toEqual([
      ["car", null, ["id", "total"], []],
      ["car-repo%", "object%", ["conn"], ["find"]],
    ]);
  });

  it("reads requires and provides", () => {
    expect(a.imports.map((i) => [i.source, i.specifiers])).toEqual([
      ["web-server/servlet", []], ["web-server/dispatch", []], ["db", []], ["./db.rkt", []], ["./crm.rkt", ["notify-closed"]],
    ]);
    expect(a.exports.map((e) => e.name)).toEqual(["start", "car"]);
  });

  it("reads dispatch-rules routes and SQL", () => {
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /cars/{integer} -> show-car",
      "POST /cars/{integer}/close -> close-car",
    ]);
    expect(a.dataSources.map((d) => `${d.kind} ${d.name} ${d.entity}`)).toEqual(["database SELECT cars"]);
  });
});

describe("Common Lisp", () => {
  const a = analyze([
    "(defpackage :shop.web",
    "  (:use :cl :caveman2)",
    "  (:import-from :shop.db #:find-car #:close-car)",
    "  (:export #:start))",
    "(in-package :shop.web)",
    "(defclass car (base-model) ((id :initarg :id :type integer) total))",
    "(defstruct (car-part (:include base)) sku (qty 1 :type integer))",
    "(defun start (&key (port 5000))",
    "  (clack:clackup *app* :port port))",
    "(defmethod total-of ((o car) &optional tax)",
    "  (+ (car-total o) (or tax 0)))",
    '(defroute "/cars/:id" (&key id) (render-json (find-car id)))',
    '(defroute ("/cars/:id/close" :method :POST) (&key id) (close-car id))',
    '(hunchentoot:define-easy-handler (health :uri "/health") () "ok")',
    '(defun crm (id) (dex:post "https://crm.example.com/v2/cars/closed" :content id))',
  ].join("\n"), "src/web.lisp", "commonlisp");

  it("reads defuns, generic methods and their specializers, classes and structs", () => {
    expect(fns(a)).toEqual([
      ["start", ["port=5000"], ["clack:clackup"]],
      ["total-of", ["o:car", "tax"], ["car-total"]],
      ["crm", ["id"], ["dex:post"]],
    ]);
    expect(a.classes.map((c) => [c.name, c.extends, c.properties.map((p) => `${p.name}:${p.type}`)])).toEqual([
      ["car", "base-model", ["id:integer", "total:null"]],
      ["car-part", "base", ["sku:null", "qty:integer"]],
    ]);
  });

  it("reads defpackage imports and exports, routes and HTTP calls", () => {
    expect(a.imports.map((i) => [i.source, i.specifiers])).toEqual([["caveman2", []], ["shop.db", ["find-car", "close-car"]]]);
    expect(a.exports.map((e) => e.name)).toEqual(["start"]);
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} [${r.calls.map((c) => c.name)}]`)).toEqual([
      "GET /cars/{id} [render-json,find-car]",
      "POST /cars/{id}/close [close-car]",
      "null /health []",
    ]);
    expect(a.dataSources.map((d) => d.name)).toEqual(["POST https://crm.example.com/v2/cars/closed"]);
  });
});

describe("Scheme", () => {
  it("reads R7RS libraries, record types and Artanis routes", () => {
    const a = analyze([
      "(define-library (shop cars)",
      "  (export find-car make-car)",
      "  (import (scheme base) (shop db))",
      "  (begin",
      "    (define-record-type <car> (make-car id total) car? (id car-id) (total car-total))",
      "    (define (find-car id) (db-query \"SELECT id FROM cars WHERE id = ?\" id))))",
      '(get "/cars/:id" (lambda (rc) (find-car (params rc "id"))))',
    ].join("\n"), "shop/cars.sld", "scheme");
    expect(fns(a)).toEqual([["<setup>", [], ["get"]], ["find-car", ["id"], ["db-query"]]]);
    expect(a.classes.map((c) => [c.name, c.properties.map((p) => p.name)])).toEqual([["car", ["id", "total"]]]);
    expect(a.imports.map((i) => i.source)).toEqual(["shop/db"]);
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} [${r.calls.map((c) => c.name)}]`)).toEqual(["GET /cars/{id} [find-car,params]"]);
  });
});

describe("Lisp packages", () => {
  it("reads info.rkt and .asd dependencies", async () => {
    const { racketPackageManager, quicklispPackageManager } = await import("./package-manifests.js");
    const info = '#lang info\n(define deps \'("base" "web-server-lib" ("db-lib" #:version "1.5") "https://github.com/racket/infrastructure-userdb.git#main"))\n(define build-deps \'("rackunit-lib"))\n';
    const asd = '(defsystem "shop" :depends-on ("caveman2" :dexador #:postmodern "shop/db") :components ((:file "web")))\n(defsystem "shop/tests" :depends-on ("shop" "rove"))\n';
    const fmt = (ps: unknown) => (ps as Array<{ name: string; version: string | null; scope: string }>).map((p) => `${p.name}@${p.version} ${p.scope}`);
    expect(fmt(racketPackageManager.manifests[0]!.parse(info, { declaredIn: "info.rkt" } as never))).toEqual(["web-server-lib@null prod", "db-lib@1.5 prod", "infrastructure-userdb@null prod", "rackunit-lib@null dev"]);
    expect(fmt(quicklispPackageManager.manifests[0]!.parse(asd, { declaredIn: "shop.asd" } as never))).toEqual(["caveman2@null prod", "dexador@null prod", "postmodern@null prod", "shop@null dev", "rove@null dev"]);
  });
});
