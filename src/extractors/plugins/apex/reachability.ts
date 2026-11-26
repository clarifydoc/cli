import type { FileAnalysis } from "../../../types/analysis.js";
import type { ReachabilityHooks, ReachabilityModel } from "../../../types/language-plugin.js";
import { splitTopLevelCommas } from "../shared/text-scan.js";
import { conventionReachability, typeLeaf } from "../shared/reachability-kit.js";

/**
 * Dead-code reachability for Apex. Apex has no imports: every class of the organisation is in one namespace and is
 * named where it is used, so files reach each other by NAME (`declaredNames`, case-folded — `clubservice.promote()`
 * is `ClubService`). What starts a program is what the platform invokes:
 *
 *   entries   triggers; `@RestResource` / `@HttpGet`…; `@AuraEnabled`, `@InvocableMethod`, `@RemoteAction`, `webservice`
 *             methods; classes implementing `Schedulable`, `Database.Batchable`, `Queueable`, an inbound-email or auth
 *             handler (the platform or a person in Setup runs them, with no call written)
 *   passive   tests (`@IsTest`, `testMethod`), `global` types and `Callable` / `TriggerAction` implementations (an API
 *             or a name the platform looks up), every SFDX metadata file (`*-meta.xml`) — alive, never reported
 *   outside   source beyond every `packageDirectories` path of `sfdx-project.json` (an unpackaged deploy folder): passive
 *   named     a class an Aura bundle, Visualforce page, flow, permission set or other `*-meta.xml` names (`controller=`,
 *             `<actionName>`) is an entry; an LWC's `@salesforce/apex` import is a symbol link
 *
 * Dynamic loading — `Type.forName('Handler_' + kind)` — keeps alive every class whose name starts with the written
 * literal (`Type.forName('Prefix_' + x)`); a name with no literal at all (`Type.forName(row.Handler__c)`) keeps every class that extends or implements
 * a type (what a loader casts to). Test code's lookups and generic type strings (`'List<' + name`) count for neither.
 */

const ENTRY_DECORATOR = /^(?:RestResource|Http(?:Get|Post|Put|Patch|Delete)|AuraEnabled|InvocableMethod|RemoteAction)\b/i;
const TEST_DECORATOR = /^(?:IsTest|TestSetup)\b/i;
const ENTRY_BASES = /^(?:Schedulable|Batchable|Queueable|InboundEmailHandler|RegistrationHandler|AuthProviderPlugin|Plugin|UrlRewriter|EmailTemplateSelector|DeployCallback|SandboxPostCopy)$/i;
const PASSIVE_BASES = /^(?:Callable|TriggerAction)$/i;
/** Config an Apex class is named in by class name (an object, field or code file's own `-meta.xml` holds none). */
const CONFIG_FILES = /(?:\.(?:cmp|app|page|component|design|evt|intf)|\.(?:flow|flexipage|md|quickAction|email|workflow|customMetadata|settings|network|site|authprovider|connectedApp|namedCredential|externalServiceRegistration|aura)-meta\.xml)$/i;

const decoratorOf = (owner: { decorators?: readonly string[] }, re: RegExp): string | undefined => owner.decorators?.find((d) => re.test(d));

function entryOf(a: FileAnalysis, relPath: string, source: string | undefined): string | null {
  // A trigger's event list may run over several lines, which the function reading (and its `Trigger(…)` decorator) does not see.
  if (/\.trigger$/i.test(relPath) || a.functions.some((f) => (f.decorators ?? []).some((d) => /^Trigger\(/.test(d)))) return "trigger (run by the platform on a data change)";
  for (const c of a.classes) {
    const dec = decoratorOf(c, ENTRY_DECORATOR);
    if (dec) return `platform entry (@${dec.replace(/\(.*$/s, "")})`;
    for (const m of c.methods) {
      const d = decoratorOf(m, ENTRY_DECORATOR);
      if (d) return `platform entry (@${d.replace(/\(.*$/s, "")} ${m.name})`;
    }
    const base = [c.extends, ...(c.implements ?? [])].filter((t): t is string => !!t).map(typeLeaf).find((t) => ENTRY_BASES.test(t));
    if (base) return `platform interface (${base})`;
  }
  if (source && /\bwebservice\s/i.test(source)) return "platform entry (webservice method)";
  return null;
}

function passiveOf(a: FileAnalysis, relPath: string, source: string | undefined): string | null {
  if (/-meta\.xml$/i.test(relPath)) return "SFDX metadata (read by the platform)";
  for (const c of a.classes) {
    if (decoratorOf(c, TEST_DECORATOR) || c.methods.some((m) => decoratorOf(m, TEST_DECORATOR))) return "test class (run by the platform's test runner)";
    const base = [c.extends, ...(c.implements ?? [])].filter((t): t is string => !!t).map(typeLeaf).find((t) => PASSIVE_BASES.test(t));
    if (base) return `looked up by name (${base})`;
  }
  if (source && /\btestMethod\b/i.test(source)) return "test class (run by the platform's test runner)";
  if (source && /(?:^|\n)\s*(?:@\w+(?:\([^)]*\))?\s+)*global\s+(?:virtual\s+|abstract\s+|with\s+sharing\s+|without\s+sharing\s+)*(?:class|interface|enum)\b/i.test(source)) return "global type (a package's API)";
  return null;
}

/** What `Type.forName(…)` can name: literal prefixes of the argument, or `null` when one has no literal at all. */
function dynamicNames(text: string): { prefixes: string[]; any: boolean } {
  const prefixes: string[] = [];
  let any = false;
  for (const m of text.matchAll(/\bType\s*\.\s*forName\s*\(([^;]*?)\)\s*(?:\.|;|\))/gi)) {
    // `forName('namespace', 'Handler_' + x)` names the class by its last argument.
    const arg = splitTopLevelCommas(m[1]!).pop()?.trim() ?? "";
    const lit = /^'([^']*)'\s*(\+)?/.exec(arg);
    if (!lit) { any = true; continue; }
    // A whole literal names exactly that class (an identifier mention already keeps it); only `'Prefix' + x` is open,
    // and `'List<' + x` / `'Map<Id,' + x` build a platform generic, never a project class.
    if (lit[2] && /^[A-Za-z_][\w.]*$/.test(lit[1]!)) prefixes.push(lit[1]!.replace(/^.*\./, ""));
    else if (lit[2] && !/[<,]/.test(lit[1]!)) any = true;
  }
  return { prefixes, any };
}

export const apexReachability: ReachabilityHooks = conventionReachability({
  extensions: [".cls", ".trigger"],
  names: { types: true, stem: true },
  caseInsensitive: true,
  configFiles: CONFIG_FILES,
  async extend(_ctx, kit, base): Promise<Partial<ReachabilityModel>> {
    const mentions = new Set<string>();
    // Everything a configuration file names was collected by the kit; `*.cls-meta.xml` and the like name no class.
    for (const n of base.configMentions ?? []) mentions.add(n.toLowerCase());
    const stems = new Map<string, string>();
    const open: string[] = [];
    let everything = false;
    for (const f of kit.files) {
      const stem = f.slice(f.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
      stems.set(stem.toLowerCase(), stem);
      if (!/\.cls$/i.test(f)) continue;
      const text = await kit.readText(f);
      if (!text || !/forName/i.test(text) || /@IsTest\b|\btestMethod\b/i.test(text)) continue;
      const d = dynamicNames(text);
      if (d.any) everything = true;
      open.push(...d.prefixes);
    }
    for (const p of open) for (const [low, s] of stems) if (low.startsWith(p.toLowerCase())) mentions.add(low);
    // A name read at run time (`Type.forName(row.Handler__c)`) can be any class that has a base to be loaded through.
    if (everything) {
      for (const f of kit.files) {
        if (!/\.cls$/i.test(f)) continue;
        const text = await kit.readText(f);
        if (text && /\bclass\s+\w+[^{;]*\b(?:extends|implements)\s/i.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""))) mentions.add(f.slice(f.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "").toLowerCase());
      }
    }
    // Source outside every `packageDirectories` path of its `sfdx-project.json` is deployed by a manifest, not by the project.
    const packaged = new Map<string, string[]>();
    for (const root of kit.roots) {
      const text = await kit.readText(root ? `${root}/sfdx-project.json` : "sfdx-project.json");
      try {
        const dirs = (JSON.parse(text ?? "null") as { packageDirectories?: Array<{ path?: string }> } | null)?.packageDirectories;
        const paths = (dirs ?? []).map((d) => (d.path ?? "").replace(/^\.?\/+|\/+$/g, "")).filter(Boolean);
        if (paths.length > 0) packaged.set(root, paths);
      } catch { /* not JSON: no rule */ }
    }
    const outsidePackages = (file: string): boolean => {
      const root = kit.rootOf(file);
      const paths = packaged.get(root);
      if (!paths) return false;
      const rel = root ? file.slice(root.length + 1) : file;
      return !paths.some((p) => rel === p || rel.startsWith(`${p}/`));
    };
    return {
      foldNames: true,
      configMentions: mentions,
      entryReason: (a, rel, _fw, readSource) => entryOf(a, rel, readSource?.()),
      passiveReason: (a, rel, _fw, readSource) =>
        outsidePackages(a.filePath) ? "outside the sfdx-project.json package directories (deployed by a manifest)" : passiveOf(a, rel, readSource?.()),
    };
  },
});
