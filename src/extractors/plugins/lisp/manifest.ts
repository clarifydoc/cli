import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { quicklispPackageManager, racketPackageManager } from "./package-manifests.js";

/**
 * Static tier of the Lisp family — Racket, Scheme and Common Lisp share one
 * form reader and one extractor (meta.ts). This module must stay a leaf:
 * types and package-manifests.ts only.
 */
export const racketManifest: LanguagePluginManifest = {
  language: "racket",
  family: "lisp",
  packageManagers: [racketPackageManager],
  packageEcosystems: ["racket"],
  parsing: "regex",
  extensions: [".rkt"],
  // `(require "orders.rkt")` brings every name the file provides into scope.
  importsShareScope: true,
  testFilePatterns: [/(?:^|\/)tests?\/.*\.rkt$/, /-test\.rkt$/],
  frameworkImportHints: { "web-server/servlet": "racket-web-server", "web-server/dispatch": "racket-web-server", koyo: "koyo" },
  activationFiles: ["info.rkt"],
};

export const schemeManifest: LanguagePluginManifest = {
  language: "scheme",
  family: "lisp",
  parsing: "regex",
  extensions: [".scm", ".ss", ".sld", ".sls"],
  // `(import (shop db))` brings the library's exports into scope.
  importsShareScope: true,
  testFilePatterns: [/(?:^|\/)tests?\/.*\.(?:scm|ss|sld|sls)$/],
};

export const commonLispManifest: LanguagePluginManifest = {
  language: "commonlisp",
  family: "lisp",
  packageManagers: [quicklispPackageManager],
  packageEcosystems: ["quicklisp"],
  parsing: "regex",
  extensions: [".lisp", ".lsp", ".asd"],
  // `(:use …)` / `(:import-from :shop.db …)` bring a package's symbols into scope.
  importsShareScope: true,
  testFilePatterns: [/(?:^|\/)t(?:ests?)?\/.*\.lisp$/],
  frameworkImportHints: { caveman2: "caveman2", ningle: "ningle", hunchentoot: "hunchentoot", "easy-routes": "easy-routes" },
};
