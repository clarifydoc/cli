import { describe, it, expect } from "vitest";
import { attachWebhookRoutes } from "./webhook-routes.js";
import { attachHandlerParams } from "./request-schemas.js";
import type { CallInfo, FileAnalysis, FunctionInfo, RouteInfo } from "../types/analysis.js";

const call = (name: string): CallInfo => ({ name, kind: "internal", target: null, line: 1 }) as CallInfo;
const fn = (name: string, calls: string[], extra: Partial<FunctionInfo> = {}): FunctionInfo =>
  ({ name, params: [], calls: calls.map(call), line: 1, endLine: 2, decorators: [], isExported: true, isAsync: false, ...extra }) as unknown as FunctionInfo;
const route = (method: string, path: string, extra: Partial<RouteInfo> = {}) =>
  ({ path, httpMethod: method, kind: "api", handler: null, calls: [], middleware: [], line: 1, filePath: "server.ts", projectId: "root", ...extra }) as RouteInfo & { filePath: string; projectId: string };
const file = (functions: FunctionInfo[], filePath = "server.ts") => ({ filePath, language: "typescript", projectId: "root", functions, classes: [] }) as unknown as FileAnalysis;
const header = (name: string) => ({ name, type: null, binding: "header" as const, inferred: true });

function judge(routes: ReturnType<typeof route>[], analyses: FileAnalysis[] = [file([])]) {
  attachHandlerParams(routes, analyses);
  return attachWebhookRoutes(routes, analyses);
}

describe("webhook routes", () => {
  it("names the provider and the verification: SDK call, hand-made HMAC, a guard, a token header", () => {
    const routes = [
      route("POST", "/webhooks/stripe", { params: [header("stripe-signature")], calls: [call("stripe.webhooks.constructEvent")] }),
      route("POST", "/webhooks/github", { params: [header("x-hub-signature-256")], calls: [call("checkGithub")] }),
      route("POST", "/hooks/slack", { middleware: ["verifySlackSignature"] }),
      route("POST", "/api/integrations/webhooks", { middleware: ["before_action :verify_slack_signature!"] }),
      route("POST", "/gitlab", { params: [header("X_GITLAB_TOKEN")], calls: [call("enqueue")] }),
      route("POST", "/api/stripe/events", { handler: "stripe_webhook" }),
    ];
    const result = judge(routes, [file([fn("checkGithub", ["crypto.createHmac", "crypto.timingSafeEqual"]), fn("enqueue", []), fn("stripe_webhook", ["stripe.Webhook.construct_event"], { requestAccess: [header("HTTP_STRIPE_SIGNATURE")] })])]);
    expect(routes.map((r) => r.webhook)).toEqual([
      { provider: "Stripe", verified: true, via: "stripe.webhooks.constructEvent" },
      { provider: "GitHub", verified: true, via: "crypto.createHmac" },
      { provider: "Slack", verified: true, via: "verifySlackSignature" },
      { provider: "Slack", verified: true, via: "before_action :verify_slack_signature!" },
      { provider: "GitLab", verified: true, via: "x-gitlab-token header" },
      { provider: "Stripe", verified: true, via: "stripe.Webhook.construct_event" },
    ]);
    expect(result).toEqual({ webhooks: 6, findings: [] });
  });

  it("finds a named sender's webhook that nothing it reaches verifies, through followed calls", () => {
    const routes = [route("POST", "/webhooks/shopify", { params: [header("x-shopify-topic")], calls: [call("saveCar"), call("JSON.parse")] })];
    const result = judge(routes, [file([fn("saveCar", ["db.insert"])])]);
    expect(routes[0]!.webhook).toEqual({ provider: "Shopify", verified: false });
    expect(result.findings).toMatchObject([{ category: "webhook-unverified", severity: "high", cwe: "CWE-345", line: 1 }]);
    expect(result.findings[0]!.message).toMatch(/^POST \/webhooks\/shopify receives Shopify webhooks but nothing it reaches checks the signature:/);
  });

  it("verification three calls deep counts; a call it cannot follow that might verify leaves it unknown", () => {
    const deep = [route("POST", "/webhooks/paddle", { calls: [call("service.handle")] })];
    judge(deep, [file([fn("handle", ["process"]), fn("process", ["checkSignature"]), fn("checkSignature", ["hmac.compare_digest"])])]);
    expect(deep[0]!.webhook).toEqual({ provider: "Paddle", verified: true, via: "hmac.compare_digest" });

    // A shared token is compared with `==`, which no call shows: unread is unknown, never a finding.
    const token = [route("POST", "/hooks/gitlab", { calls: [call("enqueue")] })];
    expect(judge(token, [file([fn("enqueue", [])])]).findings).toEqual([]);
    expect(token[0]!.webhook).toEqual({ provider: "GitLab" });

    const opaque = [route("POST", "/webhooks/stripe", { calls: [call("handleStripeEvent")] })];
    expect(judge(opaque).findings).toEqual([]);
    expect(opaque[0]!.webhook).toEqual({ provider: "Stripe" });
  });

  it("an unnamed sender is a webhook route but never a finding; GET routes, ordinary routes and webhook settings are neither", () => {
    const signedIn = { policies: ["authenticate_user!"], roles: [], schemes: [], anonymous: false, inherited: true };
    const routes = [
      route("POST", "/api/webhook", { calls: [call("log")] }),
      route("GET", "/webhooks/stripe"),
      route("POST", "/api/players", { calls: [call("save")] }),
      route("POST", "/clubs/:id/webhooks", { auth: signedIn }),
      route("POST", "/integrations/slack"),
      route("POST", "/resend_confirmation"),
      route("POST", "/twilio/callback", { calls: [call("Inbound.perform_later")] }),
      route("POST", "/inboxes/:id/register_webhook"),
      // A signature filter carried as a policy is not a sign-in.
      route("POST", "/webhooks/instagram", { auth: { ...signedIn, policies: ["before_action :verify_meta_signature! only: events"] } }),
    ];
    const result = judge(routes, [file([fn("log", []), fn("save", [])])]);
    expect(routes.map((r) => r.webhook)).toEqual([{ verified: false }, undefined, undefined, undefined, undefined, undefined, { provider: "Twilio" }, undefined, { provider: "Meta", verified: true, via: "before_action :verify_meta_signature! only: events" }]);
    expect(result).toEqual({ webhooks: 3, findings: [] });
  });

  it("tells GitHub from Meta on x-hub-signature by the path, and leaves a lodash isEqual unverified", () => {
    const routes = [
      route("POST", "/webhooks/whatsapp", { params: [header("x-hub-signature-256")], calls: [call("_.isEqual")] }),
      route("POST", "/hooks", { params: [header("x-hub-signature"), header("x-github-event")] }),
    ];
    const result = judge(routes);
    expect(routes.map((r) => r.webhook)).toEqual([{ provider: "Meta", verified: false }, { provider: "GitHub", verified: false }]);
    expect(result.findings.map((f) => f.message.split(":")[0])).toEqual([
      "POST /webhooks/whatsapp receives Meta webhooks but nothing it reaches checks the signature it reads",
      "POST /hooks receives GitHub webhooks but nothing it reaches checks the signature it reads",
    ]);
  });
});
