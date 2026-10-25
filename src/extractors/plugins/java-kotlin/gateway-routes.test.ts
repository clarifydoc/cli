import { describe, it, expect } from "vitest";
import { springGatewayProxies } from "./gateway-routes.js";

const rules = (text: string, path = "src/main/resources/application.yml") =>
  springGatewayProxies.parse(text, path).map(({ line: _l, ...r }) => r);

describe("Spring Cloud Gateway routes", () => {
  it("reads each Path predicate to its uri, rewritten by StripPrefix, RewritePath and PrefixPath", () => {
    expect(rules(`spring:
  application:
    name: gateway
  cloud:
    gateway:
      routes:
        - id: clubs
          uri: lb://clubs
          predicates:
            - Path=/api/clubs/**
          filters:
            - RewritePath=/api/clubs/(?<seg>.*), /league/clubs/\${seg}
        - id: players
          uri: http://players:8080
          predicates:
          - Path=/api/players/**,/api/squads/**
          - Method=GET
          filters:
          - StripPrefix=1
        - id: kits
          uri: http://kits:8080
          predicates:
            - Path=/kits/**
          filters:
            - PrefixPath=/v2
        - id: odd
          uri: http://odd:8080
          predicates:
            - Path=/odd/**
          filters:
            - SetPath=/{segment}
`)).toEqual([
      { pathPrefix: "/api/clubs", target: "http://clubs", rewriteTo: "/league/clubs", via: "spring-cloud-gateway" },
      { pathPrefix: "/api/players", target: "http://players:8080", rewriteTo: "/players", via: "spring-cloud-gateway" },
      { pathPrefix: "/api/squads", target: "http://players:8080", rewriteTo: "/squads", via: "spring-cloud-gateway" },
      { pathPrefix: "/kits", target: "http://kits:8080", rewriteTo: "/v2/kits", via: "spring-cloud-gateway" },
    ]);
  });

  it("reads the properties form, and never a test profile's routes", () => {
    const props = `spring.cloud.gateway.routes[0].id=clubs
spring.cloud.gateway.routes[0].uri=lb://clubs
spring.cloud.gateway.routes[0].predicates[0]=Path=/api/clubs/**
spring.cloud.gateway.routes[0].filters[0]=StripPrefix=1
`;
    expect(rules(props, "src/main/resources/application.properties")).toEqual([
      { pathPrefix: "/api/clubs", target: "http://clubs", rewriteTo: "/clubs", via: "spring-cloud-gateway" },
    ]);
    expect(rules(props, "src/main/resources/application-test.properties")).toEqual([]);
  });
});

describe("Zuul routes", () => {
  it("strips the route's prefix unless told not to, under the global prefix", () => {
    expect(rules(`zuul:
  prefix: /api
  routes:
    clubs:
      path: /clubs/**
      service-id: league
    garage:
      path: /garage/**
      url: http://garage:8080
      strip-prefix: false
    kits:
      path: /kits/**
`)).toEqual([
      { pathPrefix: "/api/clubs", target: "http://league", rewriteTo: "", via: "zuul" },
      { pathPrefix: "/api/garage", target: "http://garage:8080", rewriteTo: "/garage", via: "zuul" },
      { pathPrefix: "/api/kits", target: "http://kits", rewriteTo: "", via: "zuul" },
    ]);
  });
});
