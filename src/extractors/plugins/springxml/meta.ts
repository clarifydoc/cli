import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { springxmlSpec } from "./index.js";

/**
 * Spring XML (Web Flow definitions + bean definitions). Claims the whole
 * `.xml` extension, so the preprocess sniff below is what keeps every other
 * XML file (poms, liquibase changelogs, web.xml, …) out of the analysis —
 * skipped files never surface in the file list at all.
 */
export const springxmlMeta: LanguagePluginMeta = {
  language: "springxml",
  parsing: "regex",
  extensions: springxmlSpec.extensions,
  regexSpec: springxmlSpec,
  // Never an import target: `.xml` basenames (pom.xml, …) collide with
  // everything; flows are referenced by flow id, not module path.
  importTarget: false,
  // Declarative wiring, not code — the generic secret/injection regexes only
  // false-positive on it.
  skipSecurityScan: true,
  preprocess(rawSource) {
    const isFlow = rawSource.includes("springframework.org/schema/webflow") && /<flow[\s>]/.test(rawSource);
    const isBeans = /<beans[\s>]/.test(rawSource) && /<bean\b[^>]*\bclass\s*=/.test(rawSource);
    if (!isFlow && !isBeans) return { skip: "not a Spring flow/bean definition" };
    return null;
  },
};
