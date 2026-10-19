import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { serverlessManifest } from "./manifest.js";
import { serverlessSpec } from "./index.js";
import { serverlessHandlerAnchor } from "./route-anchor.js";

/** A `template.yaml` is SAM's only when it declares a serverless resource. */
const SAM_RE = /^\s*Transform\s*:.*AWS::Serverless|^\s*Type\s*:\s*["']?AWS::Serverless::(?:Function|Api|HttpApi)\b/m;
const SLS_RE = /^functions\s*:/m;

/**
 * Serverless routes: the API events of `serverless.yml` functions and of SAM
 * `AWS::Serverless::Function` resources become routes, which the project pass
 * moves onto the handler function they name. Configuration, not code — no
 * security scan.
 */
export const serverlessMeta: LanguagePluginMeta = {
  ...serverlessManifest,
  regexSpec: serverlessSpec,
  skipSecurityScan: true,
  routeResolvers: [serverlessHandlerAnchor],
  preprocess(rawSource, filePath) {
    const sam = /(?:^|\/)template\.ya?ml$/.test(filePath ?? "");
    if (sam ? !SAM_RE.test(rawSource) : !SLS_RE.test(rawSource)) return { skip: sam ? "not an AWS SAM template" : "no serverless functions" };
    return null;
  },
};
