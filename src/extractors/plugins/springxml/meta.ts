import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { springxmlSpec } from "./index.js";
import { springxmlManifest } from "./manifest.js";
import { WebflowUiBridgeResolver } from "./dispatch.js";
import { MyBatisMapperResolver } from "./mybatis-dispatch.js";
import { isMapperXml } from "./mybatis.js";
import { isOrmMappingXml } from "./orm-mappings.js";
import { isLiquibaseChangelog, LiquibaseChangelogEntities } from "./liquibase.js";
import { isAndroidNavGraph } from "../shared/android-nav-graph.js";

/**
 * Spring XML (Web Flow definitions + bean definitions), MyBatis mapper XML and Android navigation graphs. Claims the whole
 * `.xml` extension, so the preprocess sniff below is what keeps every other
 * XML file (poms, liquibase changelogs, web.xml, …) out of the analysis —
 * skipped files never surface in the file list at all.
 */
export const springxmlMeta: LanguagePluginMeta = {
  ...springxmlManifest,
  regexSpec: springxmlSpec,
  // Declarative wiring, not code — the generic secret/injection regexes only
  // false-positive on it.
  skipSecurityScan: true,
  dispatchResolvers: [new WebflowUiBridgeResolver(), new MyBatisMapperResolver()],
  entities: new LiquibaseChangelogEntities(),
  preprocess(rawSource) {
    const isFlow = rawSource.includes("springframework.org/schema/webflow") && /<flow[\s>]/.test(rawSource);
    const isBeans = /<beans[\s>]/.test(rawSource) && (/<bean\b[^>]*\bclass\s*=/.test(rawSource) || /<jaxrs:client\b/.test(rawSource));
    if (!isFlow && !isBeans && !isMapperXml(rawSource) && !isAndroidNavGraph(rawSource) && !isOrmMappingXml(rawSource) && !isLiquibaseChangelog(rawSource)) {
      return { skip: "not a Spring flow/bean definition, MyBatis mapper, JPA mapping file, Liquibase changelog or Android navigation graph" };
    }
    return null;
  },
};
