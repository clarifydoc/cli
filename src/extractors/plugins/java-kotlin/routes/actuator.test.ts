import { describe, it, expect } from "vitest";
import type { RouteInfo } from "../../../../types/analysis.js";
import { extractActuatorEndpoints } from "./actuator.js";

describe("Spring Boot actuator endpoints", () => {
  it("serve each operation at /actuator/{id}, a selector as a path segment (real-repo FP)", () => {
    const routes: RouteInfo[] = [];
    extractActuatorEndpoints(`@WebEndpoint(id = "stadium")
@Component
class StadiumEndpoint {
    @ReadOperation
    public Mono<Map<String, Object>> info() { return Mono.just(Map.of()); }

    @WriteOperation
    public Mono<Map<String, String>> reopen() { return Mono.just(Map.of()); }

    @DeleteOperation
    public void closeStand(@Selector String stand) { }
}`, routes);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).toEqual([
      "GET /actuator/stadium info",
      "POST /actuator/stadium reopen",
      "DELETE /actuator/stadium/{stand} closeStand",
    ]);
  });

  it("reads nothing in a class that declares no endpoint", () => {
    const routes: RouteInfo[] = [];
    extractActuatorEndpoints("class Referee { @ReadOperation public String name() { return \"x\"; } }", routes);
    expect(routes).toEqual([]);
  });
});
