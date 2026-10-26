import { describe, it, expect } from "vitest";
import { nginxProxy } from "./proxy-kit.js";

describe("nginxProxy", () => {
  it("forwards to the host before a DNS-suffix variable, and skips any other runtime variable (real-repo FP)", () => {
    const rules = nginxProxy.parse(`server {
  set $dns_suffix ".league.svc";
  location /stadium/service/ { proxy_pass http://stadium$dns_suffix:8080; }
  location /stadium/ { proxy_pass http://stadium$dns_suffix:8080/stadium/; }
  location /scores/ { proxy_pass http://$scores_host:8080; }
  location /fixtures/ { proxy_pass http://fixtures:8080$request_uri; }
}`, "nginx.conf").map(({ line: _l, ...r }) => r);
    expect(rules).toEqual([
      { pathPrefix: "/stadium/service", target: "http://stadium:8080", via: "nginx" },
      { pathPrefix: "/stadium", target: "http://stadium:8080", rewriteTo: "/stadium", via: "nginx" },
    ]);
  });
});
