import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { splitLines } from "../../shared/source-lines.js";
import { extractSchemaFragment, openapiSpec } from "./index.js";
import { openapiManifest } from "./manifest.js";
import { openapiRequestSchema } from "./request-schema.js";

/** OpenAPI/Swagger sniff: the document root must carry an `openapi: 3.x` /
 *  `swagger: "2.0"` version key. The head of the file answers for nearly every
 *  spec; a document whose keys are sorted (`components` before `openapi`, the
 *  version key 600 kB in) is found by a top-level key scan, run only when the
 *  key's spelling occurs at all — so a huge data JSON is rejected by one
 *  native substring search, never walked. */
const YAML_VERSION_RE = /^\s*(openapi|swagger)\s*:\s*["']?\d/m;
const YAML_TOP_LEVEL_RE = /^(?:openapi|swagger)\s*:\s*["']?\d/m;
const JSON_VERSION_RE = /"(openapi|swagger)"\s*:\s*"\d/;
const JSON_VALUE_RE = /^\s*:\s*"\d/;

/** Whether a JSON object's OWN keys (depth 1) include `openapi`/`swagger` with a version string. */
export function jsonHasTopLevelVersion(src: string): boolean {
  if (!JSON_VERSION_RE.test(src)) return false;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 34 /* " */) {
      const start = i + 1;
      for (i++; i < src.length; i++) {
        const d = src.charCodeAt(i);
        if (d === 92 /* \ */) i++;
        else if (d === 34) break;
      }
      if (depth !== 1 || i - start > 7) continue;
      const key = src.slice(start, i);
      if ((key === "openapi" || key === "swagger") && JSON_VALUE_RE.test(src.slice(i + 1, i + 64))) return true;
    } else if (c === 123 /* { */ || c === 91 /* [ */) depth++;
    else if (c === 125 /* } */ || c === 93 /* ] */) depth--;
  }
  return false;
}

export function isOpenApiDocument(rawSource: string): boolean {
  const head = rawSource.slice(0, 8192);
  if (/^\s*\{/.test(head)) return JSON_VERSION_RE.test(head) || (rawSource.length > head.length && jsonHasTopLevelVersion(rawSource));
  return YAML_VERSION_RE.test(head) || (rawSource.length > head.length && YAML_TOP_LEVEL_RE.test(rawSource));
}

/**
 * A JSON Schema kept in a YAML file of its own (no `openapi:` key): the root
 * declares an object (`type: object` with `properties` or a composition) or an
 * enum — keys no other YAML format puts at its top level together.
 */
const FRAGMENT_TYPE_RE = /^type\s*:\s*["']?(object|string|integer)["']?\s*$/m;
const FRAGMENT_BODY_RE = /^(?:properties|allOf|oneOf|anyOf|enum)\s*:/m;

export function isSchemaFragment(rawSource: string, relativePath: string): boolean {
  if (!/\.ya?ml$/i.test(relativePath)) return false;
  const type = FRAGMENT_TYPE_RE.exec(rawSource)?.[1];
  const body = FRAGMENT_BODY_RE.exec(rawSource)?.[0];
  if (!type || !body) return false;
  return type === "object" ? !body.startsWith("enum") : body.startsWith("enum");
}

export const openapiMeta: LanguagePluginMeta = {
  ...openapiManifest,
  regexSpec: openapiSpec,
  requestSchema: openapiRequestSchema,
  // A declarative contract, not code — generic secret/injection regexes only
  // ever false-positive on it.
  skipSecurityScan: true,
  preprocess(rawSource, relativePath) {
    if (isOpenApiDocument(rawSource)) return null;
    if (!isSchemaFragment(rawSource, relativePath)) return { skip: "not an OpenAPI/Swagger document" };
    return {
      sourceText: rawSource,
      language: "openapi",
      postExtract(analysis) {
        const name = relativePath.split("/").pop()!.replace(/\.ya?ml$/i, "");
        const { classes, relations } = extractSchemaFragment(splitLines(rawSource), name);
        analysis.classes = classes;
        if (relations.length > 0) analysis.entityRelations = relations;
      },
    };
  },
};
