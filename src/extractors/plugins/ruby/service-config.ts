import type { CallBaseRef } from "../../../types/analysis.js";
import type { ConfigEntry, ConfigSourceSpec, ServiceConfigSpec } from "../../../types/language-plugin.js";
import { yamlKeys } from "../shared/config-keys.js";

/**
 * How a Ruby program is told where other services are: `config/*.yml` (read
 * through `Rails.application.config_for(:services)`, values often ERB such as
 * `<%= ENV.fetch("LEAGUE_URL", "http://…") %>`), and `config.x.<name> = …` in
 * `config/application.rb` and `config/environments/*.rb`
 * (`Rails.configuration.x.league_url`). `.env` is never read.
 *
 * Leaf module (the static manifest imports it): types and the config-key kit only.
 */

/** Config key → the environment variables the files wire to it (`services.league_url` ← `LEAGUE_URL`). */
const envOfKey = new Map<string, Set<string>>();

const remember = (key: string, env: string): void => {
  const names = envOfKey.get(key) ?? new Set<string>();
  names.add(env);
  envOfKey.set(key, names);
};

/** The environments a Rails YAML file's top-level sections name; `default` sections are no profile. */
const SHARED_SECTION = /^(?:default|defaults|shared|common)$/i;
const ENV_SECTION = /^(?:development|test|production|staging|default|defaults|shared|common)$/i;
const TEST_PROFILE = /test/i;

/** `ENV.fetch("X", "fb")` / `ENV["X"]` inside `<%= … %>`, or bare in a Ruby value: [env name, fallback]. */
const ENV_READ = /ENV(?:\.fetch\(\s*["'](\w+)["']\s*(?:,\s*["']([^"']*)["'])?\s*\)|\[\s*["'](\w+)["']\s*\])(?:\s*\|\|\s*["']([^"']*)["'])?/;

/** `config/*.yml`: Rails-style files, environment sections over a shared one. */
const configYaml: ConfigSourceSpec = {
  files: ["config/*.yml", "config/*.yaml"],
  glob: { deep: 2, limit: 24 },
  parse(text, path) {
    const base = /([^/]+)\.ya?ml$/.exec(path)?.[1];
    if (!base) return [];
    const lines = text.split("\n");
    // ERB values read as their fallback: the YAML reader sees plain scalars.
    const plain = lines.map((l) => l.replace(/<%=\s*([\s\S]*?)\s*%>/g, (_m, code: string) => {
      const env = ENV_READ.exec(code);
      return env ? (env[2] ?? env[4] ?? "") : "";
    }));
    return yamlKeys(plain.join("\n")).map((k): ConfigEntry => {
      const parts = k.key.split(".");
      const section = ENV_SECTION.test(parts[0]!) && parts.length > 1 ? parts.shift()! : null;
      const key = [base, ...parts].join(".");
      const env = ENV_READ.exec(lines[k.line - 1] ?? "");
      if (env) remember(key, (env[1] ?? env[3])!);
      const profile = section && !SHARED_SECTION.test(section) ? section : undefined;
      return { key, value: k.value, line: k.line, ...(profile ? { profile } : {}), ...(profile && TEST_PROFILE.test(profile) ? { test: true } : {}) };
    });
  },
};

/** `config.x.league_url = "http://…"` / `ENV.fetch(…)` in `config/application.rb` and `config/environments/<env>.rb`. */
const configX: ConfigSourceSpec = {
  files: ["config/application.rb", "config/environments/*.rb"],
  glob: { deep: 2, limit: 12 },
  parse(text, path) {
    const profile = /environments\/([^/]+)\.rb$/.exec(path)?.[1];
    const out: ConfigEntry[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*config\.x\.([\w.]+)\s*=\s*(.+?)\s*$/.exec(lines[i]!);
      if (!m) continue;
      const key = `x.${m[1]}`;
      const env = ENV_READ.exec(m[2]!);
      if (env) remember(key, (env[1] ?? env[3])!);
      const written = env ? (env[2] ?? env[4]) : /^(["'])([^"'#]*)\1/.exec(m[2]!)?.[2];
      if (!written) continue;
      out.push({ key, value: written, line: i + 1, ...(profile ? { profile } : {}), ...(profile && TEST_PROFILE.test(profile) ? { test: true } : {}) });
    }
    return out;
  },
};

const literal = (s: string): string | null => {
  const m = /^(?:'([^']*)'|"([^"#]*)")$/.exec(s.trim());
  return m ? (m[1] ?? m[2]!) : null;
};

/**
 * What a Ruby base expression reads:
 *   `ENV["LEAGUE_URL"]`, `ENV.fetch("LEAGUE_URL")`          → env LEAGUE_URL
 *   `ENV.fetch("LEAGUE_URL", "http://…")`, `ENV[…] || "…"`   → the same, with a fallback
 *   `Rails.configuration.x.league_url`                       → config x.league_url
 *   `Rails.application.config_for(:services)[:league_url]`   → config services.league_url
 *   `"http://league-api:3000"`                               → literal
 */
export function rubyBaseRefOf(expr: string): CallBaseRef | null {
  const s = expr.trim().replace(/^::/, "");
  const lit = literal(s);
  if (lit !== null) return /^[a-z][a-z0-9+.-]*:\/\//i.test(lit) ? { kind: "literal", key: lit } : null;
  const env = new RegExp(`^${ENV_READ.source}$`).exec(s);
  if (env) {
    const fallback = env[2] ?? env[4];
    return { kind: "env", key: (env[1] ?? env[3])!, ...(fallback && /^https?:\/\//i.test(fallback) ? { fallback } : {}) };
  }
  const x = /^Rails\.(?:application\.)?config(?:uration)?\.x\.([\w.]+)$/.exec(s);
  if (x) return { kind: "config", key: `x.${x[1]}` };
  const cf = /^Rails\.application\.config_for\(\s*:?["']?(\w+)["']?\s*\)\s*(?:\[\s*:?["']?(\w+)["']?\s*\]|\.(\w+))$/.exec(s);
  if (cf) return { kind: "config", key: `${cf[1]}.${cf[2] ?? cf[3]}` };
  return null;
}

export const rubyServiceConfig: ServiceConfigSpec = {
  sources: [configYaml, configX],
  baseRefOf: rubyBaseRefOf,
  envNamesFor: (key) => [...(envOfKey.get(key) ?? [])],
};
