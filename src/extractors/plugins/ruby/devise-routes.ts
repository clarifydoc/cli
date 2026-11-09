import type { ClassInfo, FileAnalysis, RouteFact, RouteInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { applyRouteMeta, type GuardAttr } from "../../shared/route-metadata.js";
import { singularize } from "../shared/inflection.js";
import { rubyLexicalConstants } from "./autoload.js";

/**
 * Devise's routes. `devise_for :players` draws, under `/players`, the routes of
 * each Devise module the model's own `devise :database_authenticatable, …`
 * line enables — two files' facts, joined here:
 *
 * - the router's `devise_for` (`rails-devise-for`: resources, options, and the
 *   path, helper prefix, controller module and guards of the scope around it);
 * - the model's `devise` statement (`rails-devise-modules`), found on the model
 *   or the first ancestor that has one (`class Captain < Player`);
 * - the initializer's `config.omniauth :x` / `sign_out_via` / `unlock_strategy` /
 *   `omniauth_path_prefix` (`rails-devise-config`), for what the model leaves to it.
 *
 * Paths, verbs and helpers are Devise's documented defaults
 * (`lib/devise/rails/routes.rb`), renamed by `path:` / `path_names:`, narrowed by
 * `skip:` / `only:`. Each row is served by Devise's own controller
 * (`Devise::SessionsController`), the scope's module's (`namespace :staff` →
 * `Staff::SessionsController`, as Devise does) or the one `controllers:` names.
 * Nothing is drawn for a model whose `devise` line the project does not state.
 */

/** A module that draws routes → the controller group serving them. */
const MODULE_GROUPS: Readonly<Record<string, string>> = {
  database_authenticatable: "sessions",
  recoverable: "passwords",
  registerable: "registrations",
  confirmable: "confirmations",
  lockable: "unlocks",
  omniauthable: "omniauth_callbacks",
};
const GROUP_ORDER = ["sessions", "passwords", "registrations", "confirmations", "unlocks", "omniauth_callbacks"];

const DEFAULT_PATH_NAMES: Readonly<Record<string, string>> = {
  sign_in: "sign_in", sign_out: "sign_out", password: "password", sign_up: "sign_up", edit: "edit",
  cancel: "cancel", confirmation: "confirmation", unlock: "unlock", registration: "",
};

/**
 * What each action of Devise's own controller does to the model (read = looks the account
 * up, write = stores it or a token on it), for `route-anchor`'s `rails-devise-model` pass.
 * Actions that only render a form are left out.
 */
const DEVISE_ACCESS: Readonly<Record<string, "read" | "write">> = {
  "sessions#create": "read",
  "registrations#create": "write",
  "registrations#edit": "read",
  "registrations#update": "write",
  "registrations#destroy": "write",
  "passwords#create": "write",
  "passwords#update": "write",
  "confirmations#create": "write",
  "confirmations#show": "write",
  "unlocks#create": "write",
  "unlocks#show": "write",
};

interface DeviseForOptions {
  path?: string;
  className?: string;
  module?: string;
  as?: string;
  controllers: Record<string, string>;
  skip: string[] | "all";
  only?: string[];
  pathNames: Record<string, string>;
  signOutVia?: string[];
}

interface DeviseFor {
  resources: string[];
  prefix: string;
  namePrefix: string;
  modules: string[];
  guards: GuardAttr[];
  options: DeviseForOptions;
}

interface DeviseModel {
  model: string;
  modules: string[];
  providers?: string[];
  unlockStrategy?: string;
}

interface DeviseConfig {
  providers: string[];
  /** `config.omniauth_path_prefix`: where every mapping's OmniAuth routes sit instead of `<mapping>/auth`. */
  omniauthPathPrefix?: string;
  signOutVia?: string[];
  unlockStrategy?: string;
}

const symbolsIn = (text: string): string[] => [...text.matchAll(/:(\w+)/g)].map((m) => m[1]!);

/** `[:a, :b]`, `%i[a b]` or `:a` after `key:` / `:key =>`. */
function listOption(stmt: string, key: string): string[] | null {
  const at = new RegExp(String.raw`(?:\b${key}:|:${key}\s*=>)\s*`).exec(stmt);
  if (!at) return null;
  const rest = stmt.slice(at.index + at[0].length);
  const array = /^\[([^\]]*)\]/.exec(rest);
  if (array) return symbolsIn(array[1]!).concat([...array[1]!.matchAll(/['"](\w+)['"]/g)].map((m) => m[1]!));
  const words = /^%[iw][[(]([^\])]*)[\])]/.exec(rest);
  if (words) return words[1]!.trim().split(/\s+/).filter(Boolean);
  const one = /^:?['"]?(\w+)/.exec(rest);
  return one ? [one[1]!] : null;
}

function stringOption(stmt: string, key: string): string | undefined {
  return new RegExp(String.raw`(?:\b${key}:|:${key}\s*=>)\s*(?::(\w+)|['"]([^'"]*)['"])`).exec(stmt)?.slice(1).find((v) => v !== undefined);
}

function hashOption(stmt: string, key: string): Record<string, string> {
  const body = new RegExp(String.raw`(?:\b${key}:|:${key}\s*=>)\s*\{([^}]*)\}`).exec(stmt)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(?:\b(\w+):|:(\w+)\s*=>)\s*(?::(\w+)|['"]([^'"]*)['"])/g)) out[m[1] ?? m[2]!] = m[3] ?? m[4]!;
  return out;
}

/** The router's `devise_for` statement (joined over its lines) → its fact, with the scope it sits in. */
export function deviseForFact(
  stmt: string,
  line: number,
  scope: { prefix: string; namePrefix: string; modules: readonly string[]; guards: readonly GuardAttr[] },
): RouteFact | null {
  const args = stmt.replace(/^devise_for\s*\(?\s*/, "");
  // The resources come before the first option.
  const head = args.split(/\b\w+:(?!:)|=>/)[0] ?? "";
  const resources = symbolsIn(head);
  if (resources.length === 0) return null;
  const skip = listOption(args, "skip");
  const only = listOption(args, "only");
  const signOutVia = listOption(args, "sign_out_via");
  const options: DeviseForOptions = {
    controllers: hashOption(args, "controllers"),
    skip: skip?.includes("all") ? "all" : skip ?? [],
    pathNames: hashOption(args, "path_names"),
  };
  const path = stringOption(args, "path");
  if (path !== undefined) options.path = path;
  const className = stringOption(args, "class_name");
  if (className) options.className = className;
  const module = stringOption(args, "module");
  if (module) options.module = module;
  const as = stringOption(args, "as");
  if (as) options.as = as;
  if (only) options.only = only;
  if (signOutVia) options.signOutVia = signOutVia;
  const data: DeviseFor = { resources, prefix: scope.prefix, namePrefix: scope.namePrefix, modules: [...scope.modules], guards: [...scope.guards], options };
  return { kind: "rails-devise-for", line, data };
}

/** A statement from line `i`, joined while it goes on (a trailing comma or operator, an open bracket). */
function statementFrom(lines: readonly string[], i: number): { text: string; end: number } {
  const code = (k: number) => (lines[k] ?? "").replace(/\s#.*$/, "").trim();
  let text = code(i);
  let end = i;
  const open = (t: string) => (t.match(/[{[(]/g)?.length ?? 0) - (t.match(/[}\])]/g)?.length ?? 0);
  while ((open(text) > 0 || /[,\\]$/.test(text)) && end + 1 < lines.length && end - i < 30) text += " " + code(++end);
  return { text, end };
}

/** A model's `devise :a, :b` statement and an initializer's Devise settings, as route facts. */
export function extractDeviseFacts(lines: readonly string[], classes: readonly ClassInfo[], facts?: RouteFact[]): void {
  if (!facts) return;
  if (lines.some((l) => /^\s*devise\s+:/.test(l))) {
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*devise\s+:/.test(lines[i] ?? "")) continue;
      const owner = classes
        .filter((c) => c.line <= i + 1 && i + 1 <= c.endLine && /^\s*class\s/.test(lines[c.line - 1] ?? ""))
        .sort((a, b) => b.line - a.line)[0];
      if (!owner) continue;
      const { text, end } = statementFrom(lines, i);
      const head = text.replace(/^devise\s+/, "").split(/\b\w+:(?!:)|=>/)[0] ?? "";
      const data: DeviseModel = { model: rubyLexicalConstants.pathOf(owner, classes), modules: symbolsIn(head) };
      const providers = listOption(text, "omniauth_providers");
      if (providers) data.providers = providers;
      const unlock = stringOption(text, "unlock_strategy");
      if (unlock) data.unlockStrategy = unlock;
      facts.push({ kind: "rails-devise-modules", line: i + 1, data });
      i = end;
    }
  }
  if (lines.some((l) => /\bDevise\.setup\b/.test(l))) {
    const data: DeviseConfig = { providers: [] };
    for (const raw of lines) {
      const line = raw.replace(/\s#.*$/, "");
      const provider = /^\s*config\.omniauth\s*\(?\s*:(\w+)/.exec(line);
      if (provider) data.providers.push(provider[1]!);
      const via = /^\s*config\.sign_out_via\s*=\s*(.+)$/.exec(line);
      if (via) data.signOutVia = symbolsIn(via[1]!);
      const unlock = /^\s*config\.unlock_strategy\s*=\s*:(\w+)/.exec(line);
      if (unlock) data.unlockStrategy = unlock[1]!;
      const prefix = /^\s*config\.omniauth_path_prefix\s*=\s*['"]([^'"]+)['"]/.exec(line);
      if (prefix) data.omniauthPathPrefix = prefix[1]!;
    }
    if (data.providers.length > 0 || data.signOutVia || data.unlockStrategy || data.omniauthPathPrefix) facts.push({ kind: "rails-devise-config", line: 1, data });
  }
}

const camelize = (token: string): string => token.split(/[_/]/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
/** `staff/sessions` → `Staff::SessionsController`. */
const controllerClass = (token: string): string => token.split("/").filter(Boolean).map(camelize).join("::") + "Controller";

interface Row { group: string; action: string; method: string; path: string; name: string }

/** The rows one group draws under the mapping's path, as Devise's `devise_<group>` helpers do. */
function groupRows(group: string, base: string, singular: string, names: Record<string, string>, signOutVia: readonly string[], providers: readonly string[], omniauthBase: string): Row[] {
  const seg = (name: string) => (names[name] ? `/${names[name]}` : "");
  const rows: Row[] = [];
  const add = (action: string, methods: readonly string[], path: string, name: string, from = base) => {
    for (const method of methods) rows.push({ group, action, method, path: from + path || "/", name });
  };
  switch (group) {
    case "sessions":
      add("new", ["GET"], seg("sign_in"), `new_${singular}_session`);
      add("create", ["POST"], seg("sign_in"), `${singular}_session`);
      add("destroy", signOutVia.map((v) => v.toUpperCase()), seg("sign_out"), `destroy_${singular}_session`);
      break;
    case "passwords": {
      const p = seg("password");
      add("new", ["GET"], `${p}/new`, `new_${singular}_password`);
      add("edit", ["GET"], `${p}/edit`, `edit_${singular}_password`);
      add("update", ["PATCH", "PUT"], p, `${singular}_password`);
      add("create", ["POST"], p, `${singular}_password`);
      break;
    }
    case "registrations": {
      const p = seg("registration");
      add("cancel", ["GET"], `${p}${seg("cancel")}`, `cancel_${singular}_registration`);
      add("new", ["GET"], `${p}${seg("sign_up")}`, `new_${singular}_registration`);
      add("edit", ["GET"], `${p}${seg("edit")}`, `edit_${singular}_registration`);
      add("update", ["PATCH", "PUT"], p, `${singular}_registration`);
      add("destroy", ["DELETE"], p, `${singular}_registration`);
      add("create", ["POST"], p, `${singular}_registration`);
      break;
    }
    case "confirmations":
    case "unlocks": {
      const one = group === "confirmations" ? "confirmation" : "unlock";
      const p = seg(one);
      add("new", ["GET"], `${p}/new`, `new_${singular}_${one}`);
      add("show", ["GET"], p, `${singular}_${one}`);
      add("create", ["POST"], p, `${singular}_${one}`);
      break;
    }
    case "omniauth_callbacks":
      // OmniAuth 2 starts a request phase on POST only; the provider calls back on either verb.
      for (const provider of providers) {
        add("passthru", ["POST"], `/${provider}`, `${singular}_${provider}_omniauth_authorize`, omniauthBase);
        add(provider, ["GET", "POST"], `/${provider}/callback`, `${singular}_${provider}_omniauth_callback`, omniauthBase);
      }
      break;
  }
  return rows;
}

export const railsDeviseRoutes: RouteResolver = {
  id: "rails-devise-routes",
  languages: ["ruby"],
  // Before the route anchor, which moves a row onto a project controller that defines its action.
  priority: 45,
  resolve(analyses: FileAnalysis[], _ctx: ProjectContext): void {
    const ruby = analyses.filter((a) => a.language === "ruby");
    const fors = ruby.flatMap((a) => (a.routeFacts ?? []).filter((f) => f.kind === "rails-devise-for").map((f) => ({ a, f })));
    if (fors.length === 0) return;
    const models = new Map<string, DeviseModel | null>();
    let config: DeviseConfig | null = null;
    for (const a of ruby) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind === "rails-devise-modules") {
          const d = f.data as DeviseModel;
          models.set(d.model, models.has(d.model) ? null : d);
        } else if (f.kind === "rails-devise-config") config = f.data as DeviseConfig;
      }
    }
    // Every class by full path → what it extends, for a model that inherits its `devise` line.
    const supers = new Map<string, string | null>();
    const byLeaf = new Map<string, string[]>();
    for (const a of ruby) {
      for (const cls of a.classes) {
        const path = rubyLexicalConstants.pathOf(cls, a.classes);
        supers.set(path, supers.has(path) ? null : cls.extends?.replace(/^::/, "") ?? null);
        const leaf = path.split("::").pop()!;
        byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), path]);
      }
    }
    const declared = (name: string): string | null => {
      if (supers.has(name)) return name;
      const hits = byLeaf.get(name.split("::").pop()!) ?? [];
      return hits.length === 1 ? hits[0]! : null;
    };
    const deviseOf = (className: string): DeviseModel | null => {
      let name = declared(className);
      for (let k = 0; name && k < 8; k++) {
        const own = models.get(name);
        if (own) return own;
        if (own === null) return null;
        const up = supers.get(name);
        name = up ? declared(up) : null;
      }
      return null;
    };

    for (const { a, f } of fors) {
      const d = f.data as DeviseFor;
      const o = d.options;
      for (const resource of d.resources) {
        const className = (o.className ?? camelize(singularize(resource))).replace(/^::/, "");
        const model = deviseOf(className);
        if (!model) continue;
        const wanted = (list: readonly string[]) => new Set(list.map((s) => singularize(s)));
        let groups = GROUP_ORDER.filter((g) => model.modules.some((m) => MODULE_GROUPS[m] === g));
        if (o.only) groups = groups.filter((g) => wanted(o.only!).has(singularize(g)));
        else if (o.skip === "all") groups = [];
        else groups = groups.filter((g) => !wanted(o.skip as string[]).has(singularize(g)));
        const unlockStrategy = model.unlockStrategy ?? config?.unlockStrategy ?? "both";
        if (unlockStrategy !== "both" && unlockStrategy !== "email") groups = groups.filter((g) => g !== "unlocks");
        const scopeAs = o.as ? `${o.as}_` : d.namePrefix;
        const singular = `${scopeAs}${singularize(resource)}`;
        const base = `${d.prefix}/${(o.path ?? resource).replace(/^\/+|\/+$/g, "")}`.replace(/\/+$/, "").replace(/\/{2,}/g, "/");
        const names = { ...DEFAULT_PATH_NAMES, ...o.pathNames };
        const signOutVia = o.signOutVia ?? config?.signOutVia ?? ["delete"];
        const providers = model.providers ?? config?.providers ?? [];
        const module = o.module ? o.module.split("/").map(camelize) : d.modules;
        for (const group of groups) {
          const own = o.controllers[group];
          const controller = own ? controllerClass(own) : module.length > 0 ? `${module.join("::")}::${camelize(group)}Controller` : `Devise::${camelize(group)}Controller`;
          const omniauthBase = (config?.omniauthPathPrefix ?? `${base}/auth`).replace(/\/+$/, "");
          for (const row of groupRows(group, base, singular, names, signOutVia, providers, omniauthBase)) {
            const handler = `${controller}#${row.action}`;
            const route: RouteInfo = { path: row.path, httpMethod: row.method, kind: "api", handler, calls: [], middleware: [], line: f.line, name: row.name };
            a.routes.push(d.guards.length > 0 ? applyRouteMeta(route, { inheritedGuards: d.guards }) : route);
            const access = DEVISE_ACCESS[`${group}#${row.action}`];
            if (access) (a.routeFacts ??= []).push({ kind: "rails-devise-model", line: f.line, data: { model: declared(className) ?? className, method: row.method, path: row.path, handler, action: row.action, access, gem: "Devise" } });
          }
        }
      }
    }
  },
};
