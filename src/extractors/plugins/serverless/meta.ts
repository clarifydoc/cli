import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { serverlessManifest } from "./manifest.js";
import { serverlessSpec } from "./index.js";
import { serverlessHandlerAnchor } from "./route-anchor.js";
import { functionJsonEntryPoints, functionJsonRoutes, parseFunctionJson } from "./function-json.js";
import { daprSubscriptions } from "./dapr.js";

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
  // A Dapr `kind: Subscription` (handed over by the owner of `.yaml`): the route it delivers to consumes the topic.
  routeResolvers: [serverlessHandlerAnchor, daprSubscriptions],
  preprocess(rawSource, filePath) {
    if (/(?:^|\/)function\.json$/.test(filePath ?? "")) {
      // An Azure Functions folder: the function is named after it.
      if (!parseFunctionJson(rawSource) || !/"type"\s*:\s*"\w+Trigger"/i.test(rawSource)) return { skip: "no Azure Functions trigger" };
      const parts = (filePath ?? "").split("/");
      const name = parts.length >= 2 ? parts[parts.length - 2]! : "";
      if (!name) return { skip: "an Azure function lives in its own folder" };
      return {
        sourceText: rawSource,
        language: "serverless",
        postExtract(analysis) {
          analysis.routes = functionJsonRoutes(rawSource, name);
          const entries = functionJsonEntryPoints(rawSource, name);
          analysis.entryPoints = entries.length ? entries : undefined;
        },
      };
    }
    const sam = /(?:^|\/)template\.ya?ml$/.test(filePath ?? "");
    if (sam ? !SAM_RE.test(rawSource) : !SLS_RE.test(rawSource)) return { skip: sam ? "not an AWS SAM template" : "no serverless functions" };
    return null;
  },
};
