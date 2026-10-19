import type { FileAnalysis, RouteAuthInfo, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";

/**
 * Spring Security's URL rules, as the routes' guards.
 *
 *   http.authorizeHttpRequests(auth -> auth
 *       .requestMatchers("/api/public/**").permitAll()
 *       .requestMatchers(HttpMethod.DELETE, "/api/orders/**").hasRole("ADMIN")
 *       .anyRequest().authenticated());
 *
 * Read in declaration order (`requestMatchers`, `antMatchers`, `mvcMatchers`,
 * `regexMatchers`, WebFlux `pathMatchers`, `anyRequest`/`anyExchange`; the
 * Kotlin DSL's `authorize("/x/**", hasRole("ADMIN"))`), the first rule a
 * request matches decides — as Spring evaluates them. Each route takes the
 * first rule its method and path match: the rule as middleware, and its
 * `auth` when the route states none of its own (a method annotation such as
 * `@PreAuthorize` is the narrower statement and is kept). A project with
 * several filter chains (`securityMatcher`) is read as one ordered list per
 * file; files whose rules disagree on a route leave it alone.
 */

export const SPRING_SECURITY_FACT = "spring:security-rules";

export interface SecurityRule {
  /** Ant-style patterns; empty = any request. */
  patterns: string[];
  /** Upper-case HTTP method the matcher is limited to, or null. */
  method: string | null;
  /** As written: `permitAll`, `authenticated`, `hasRole("ADMIN")`. */
  rule: string;
  line: number;
}

const GATE = /authorizeHttpRequests|authorizeRequests|authorizeExchange|\bauthorize\s*\(/;
const MATCHER_RE = /\.(requestMatchers|antMatchers|mvcMatchers|regexMatchers|pathMatchers)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)|\.(anyRequest|anyExchange)\s*\(\s*\)/g;
const RULE_RE = /^\s*\.(permitAll|authenticated|fullyAuthenticated|denyAll|anonymous|rememberMe|hasRole|hasAnyRole|hasAuthority|hasAnyAuthority|access|hasIpAddress)\s*\(([^()]*)\)/;
const KOTLIN_RE = /\bauthorize\s*\(\s*(?:(HttpMethod\.\w+)\s*,\s*)?("(?:[^"\\]|\\.)*"|anyRequest)\s*,\s*([A-Za-z]+(?:\([^()]*\))?)\s*\)/g;

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

/** The `authorizeHttpRequests` rules a configuration file declares, in order. */
export function extractSecurityRules(sourceText: string): SecurityRule[] {
  if (!GATE.test(sourceText)) return [];
  const text = sourceText.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
  const rules: SecurityRule[] = [];
  for (const m of text.matchAll(MATCHER_RE)) {
    const after = RULE_RE.exec(text.slice(m.index! + m[0].length));
    if (!after) continue;
    const args = m[2] ?? "";
    const method = /HttpMethod\.(\w+)/.exec(args)?.[1]?.toUpperCase() ?? null;
    const patterns = [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((p) => p[1]!);
    if (m[1] && patterns.length === 0) continue; // a matcher object we cannot read (`PathRequest.toStaticResources()`)
    rules.push({ patterns: m[3] ? [] : patterns, method, rule: ruleText(after[1]!, after[2]!), line: lineOf(text, m.index!) });
  }
  for (const m of text.matchAll(KOTLIN_RE)) {
    const target = m[2]!;
    rules.push({
      patterns: target === "anyRequest" ? [] : [target.slice(1, -1)],
      method: m[1] ? m[1].slice("HttpMethod.".length).toUpperCase() : null,
      rule: m[3]!.replace(/\s+/g, ""),
      line: lineOf(text, m.index!),
    });
  }
  return rules.sort((a, b) => a.line - b.line);
}

const ruleText = (name: string, args: string): string => (args.trim() ? `${name}(${args.trim()})` : name);

/** An Ant path pattern as a test on route paths: `**` any segments, `*` one segment's text, `{x}` a segment. */
function antMatcher(pattern: string): (path: string) => boolean {
  const norm = (p: string) => p.replace(/\{[^}]*\}|:[A-Za-z_]\w*/g, "{}").replace(/\/+$/, "") || "/";
  const src = norm(pattern)
    .split(/(\*\*|\*|\{\})/)
    .map((part) => (part === "**" ? "\u0000" : part === "*" ? "[^/]*" : part === "{}" ? "[^/]+" : part.replace(/[.+?^$()|[\]\\]/g, "\\$&")))
    .join("")
    // `/x/**` also matches `/x` itself.
    .replace(/\/\u0000/g, "(?:/.*)?")
    .replace(/\u0000/g, ".*");
  const re = new RegExp(`^${src}$`);
  return (path) => re.test(norm(path));
}

/** What a rule says about who may call, as a route's `auth`. */
function authOfRule(rule: string): RouteAuthInfo {
  const args = [...rule.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]!);
  const name = rule.replace(/\(.*$/, "");
  const roles = /^has(?:Any)?Role$/.test(name) ? args : [];
  const policies = /^has(?:Any)?Authority$|^access$|^hasIpAddress$/.test(name) ? args : roles.length || name === "permitAll" || name === "anonymous" ? [] : [name];
  return { policies, roles, schemes: [], anonymous: name === "permitAll" || name === "anonymous", inherited: true };
}

export const springSecurityResolver: RouteResolver = {
  id: "spring-security-rules",
  languages: ["java", "kotlin"],
  priority: 90,
  resolve(analyses: FileAnalysis[]): void {
    const lists: SecurityRule[][] = [];
    for (const a of analyses) {
      const rules = (a.routeFacts ?? []).filter((f) => f.kind === SPRING_SECURITY_FACT).flatMap((f) => (f.data as { rules: SecurityRule[] }).rules);
      if (rules.length > 0) lists.push(rules);
    }
    if (lists.length === 0) return;
    const compiled = lists.map((rules) => rules.map((r) => ({ ...r, tests: r.patterns.map(antMatcher) })));
    const ruleFor = (route: RouteInfo): SecurityRule | null => {
      let chosen: SecurityRule | null | undefined;
      for (const rules of compiled) {
        const hit = rules.find((r) => (!r.method || r.method === route.httpMethod) && (r.tests.length === 0 || r.tests.some((t) => t(route.path)))) ?? null;
        if (!hit) continue;
        if (chosen !== undefined && chosen?.rule !== hit.rule) return null;
        chosen = hit;
      }
      return chosen ?? null;
    };
    for (const a of analyses) {
      if (!a.routes.some((r) => r.kind === "api" && !r.mount)) continue;
      a.routes = a.routes.map((r) => {
        if (r.kind !== "api" || r.mount) return r;
        const rule = ruleFor(r);
        if (!rule) return r;
        return { ...r, middleware: [...r.middleware, rule.rule], ...(r.auth ? {} : { auth: authOfRule(rule.rule) }) };
      });
    }
  },
};

/** Per-file: the rules as a route fact for the resolver. */
export function collectSecurityRules(sourceText: string, facts: RouteFact[] | undefined): void {
  if (!facts) return;
  const rules = extractSecurityRules(sourceText);
  if (rules.length > 0) facts.push({ kind: SPRING_SECURITY_FACT, line: rules[0]!.line, data: { rules } });
}
