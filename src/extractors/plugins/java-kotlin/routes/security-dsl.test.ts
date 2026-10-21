import { describe, it, expect } from "vitest";
import { extractSecurityRules, springSecurityResolver, SPRING_SECURITY_FACT } from "./security-dsl.js";
import { createEmptyAnalysis, type FileAnalysis, type RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";

const CONFIG = `@Configuration
public class SecurityConfig {
  @Bean
  SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    http
      .csrf(csrf -> csrf.disable())
      .authorizeHttpRequests(auth -> auth
        // static files first
        .requestMatchers(PathRequest.toStaticResources().atCommonLocations()).permitAll()
        .requestMatchers("/api/public/**", "/actuator/health").permitAll()
        .requestMatchers(HttpMethod.DELETE, "/api/cars/**").hasRole("ADMIN")
        .requestMatchers("/api/admin/*").hasAnyAuthority("SCOPE_admin", "ROLE_OPS")
        .anyRequest().authenticated());
    return http.build();
  }
}`;

const route = (httpMethod: string, path: string, auth?: RouteInfo["auth"]): RouteInfo => ({ path, httpMethod, kind: "api", handler: null, calls: [], middleware: [], line: 1, ...(auth ? { auth } : {}) });

describe("Spring Security DSL", () => {
  it("reads the matchers in order, with their method, patterns and rule; skips matchers it cannot read", () => {
    expect(extractSecurityRules(CONFIG).map((r) => `${r.method ?? "*"} ${r.patterns.join(",") || "<any>"} ${r.rule}`)).toEqual([
      "* /api/public/**,/actuator/health permitAll",
      "DELETE /api/cars/** hasRole(\"ADMIN\")",
      "* /api/admin/* hasAnyAuthority(\"SCOPE_admin\", \"ROLE_OPS\")",
      "* <any> authenticated",
    ]);
  });

  it("reads the Kotlin DSL", () => {
    const kt = `http { authorizeHttpRequests { authorize("/admin/**", hasRole("ADMIN")); authorize(HttpMethod.GET, "/docs", permitAll); authorize(anyRequest, authenticated) } }`;
    expect(extractSecurityRules(kt).map((r) => `${r.method ?? "*"} ${r.patterns.join(",") || "<any>"} ${r.rule}`)).toEqual([
      "* /admin/** hasRole(\"ADMIN\")",
      "GET /docs permitAll",
      "* <any> authenticated",
    ]);
  });

  it("gives each route the first rule it matches, keeping a method annotation's own auth", () => {
    const config: FileAnalysis = { ...createEmptyAnalysis("src/SecurityConfig.java", "java"), routeFacts: [{ kind: SPRING_SECURITY_FACT, line: 1, data: { rules: extractSecurityRules(CONFIG) } }] };
    const ctl: FileAnalysis = {
      ...createEmptyAnalysis("src/CarController.java", "java"),
      routes: [
        route("GET", "/api/public/catalog"),
        route("GET", "/api/public"),
        route("DELETE", "/api/cars/{id}"),
        route("GET", "/api/cars/{id}"),
        route("POST", "/api/admin/players"),
        route("POST", "/api/admin/players/{id}/lock"),
        route("GET", "/api/me", { policies: ["isAuthenticated()"], roles: [], schemes: [], anonymous: false, inherited: false }),
      ],
    };
    springSecurityResolver.resolve([config, ctl], {} as ProjectContext);
    expect(ctl.routes.map((r) => `${r.httpMethod} ${r.path} [${r.middleware.join(",")}] ${r.auth ? (r.auth.anonymous ? "anonymous" : [...r.auth.roles, ...r.auth.policies].join("+")) : "-"}`)).toEqual([
      "GET /api/public/catalog [permitAll] anonymous",
      "GET /api/public [permitAll] anonymous",
      "DELETE /api/cars/{id} [hasRole(\"ADMIN\")] ADMIN",
      "GET /api/cars/{id} [authenticated] authenticated",
      "POST /api/admin/players [hasAnyAuthority(\"SCOPE_admin\", \"ROLE_OPS\")] SCOPE_admin+ROLE_OPS",
      "POST /api/admin/players/{id}/lock [authenticated] authenticated",
      "GET /api/me [authenticated] isAuthenticated()",
    ]);
  });
});
