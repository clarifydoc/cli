import type { CallInfo, FileAnalysis, FunctionInfo, RouteInfo, SecurityIssue } from "../types/analysis.js";
import { handlerOf } from "./request-schemas.js";

/**
 * Routes that receive a third-party webhook, and whether they check its
 * signature (`RouteInfo.webhook`).
 *
 * A route is a webhook receiver when it reads a provider's webhook header
 * (`stripe-signature`, `x-hub-signature-256`, `svix-signature`), calls a
 * provider's verification (`stripe.webhooks.constructEvent`,
 * `stripe.Webhook.construct_event`, `twilio.validateRequest`), or its path
 * says so (`/webhooks/stripe`, `/hooks/github`). The provider is named from
 * the same evidence — header, then call, then a path segment.
 *
 * Verified: something in the route's reach checks the signature — the
 * provider's own verify call, a constant-time compare or an HMAC computed
 * (`timingSafeEqual`, `hmac.compare_digest`, `createHmac`), a call or
 * middleware/decorator named for it (`verifySignature`, `StripeSignatureGuard`),
 * or a shared-secret token header read (GitLab's `x-gitlab-token`, compared
 * by hand). The reach is the inline handler's calls, or the resolved handler
 * function's, followed by name into the project's own functions (unique in
 * the sub-project) up to three calls deep.
 *
 * Not verified only when the whole reach is known: every call either leads
 * into a function we followed, or names nothing that could verify (a call
 * named `handle`/`process`/`check…` we could not follow leaves it unknown).
 * That is the finding — "anyone can post a forged event" — so it is
 * conservative by construction. Provider knowledge here is about services,
 * not languages: the SDK spellings of each language are listed together.
 */

interface Provider {
  name: string;
  /** Headers that carry the signature (or the shared secret). */
  signature: readonly string[];
  /** Headers that only identify the provider (`x-github-event`). */
  info?: readonly string[];
  /** The signature header is a shared token the handler compares itself. */
  token?: true;
  /** Path segments that name it. */
  path: RegExp;
}

const PROVIDERS: readonly Provider[] = [
  { name: "Stripe", signature: ["stripe-signature"], path: /^stripe$/ },
  { name: "GitHub", signature: [], info: ["x-github-event", "x-github-delivery", "x-github-hook-id"], path: /^github$/ },
  { name: "GitLab", signature: ["x-gitlab-token"], info: ["x-gitlab-event"], token: true, path: /^gitlab$/ },
  { name: "Slack", signature: ["x-slack-signature"], info: ["x-slack-request-timestamp"], path: /^slack$/ },
  { name: "Shopify", signature: ["x-shopify-hmac-sha256"], info: ["x-shopify-topic", "x-shopify-shop-domain", "x-shopify-webhook-id"], path: /^shopify$/ },
  { name: "Twilio", signature: ["x-twilio-signature"], path: /^(?:twilio|sms|voice)$/ },
  { name: "SendGrid", signature: ["x-twilio-email-event-webhook-signature"], path: /^sendgrid$/ },
  { name: "Svix", signature: ["svix-signature"], info: ["svix-id", "svix-timestamp"], path: /^(?:svix|clerk|resend)$/ },
  { name: "Standard Webhooks", signature: ["webhook-signature"], info: ["webhook-id", "webhook-timestamp"], path: /^$/ },
  { name: "PayPal", signature: ["paypal-transmission-sig"], info: ["paypal-transmission-id", "paypal-cert-url"], path: /^paypal$/ },
  { name: "Paddle", signature: ["paddle-signature"], path: /^paddle$/ },
  { name: "Linear", signature: ["linear-signature"], path: /^linear$/ },
  { name: "Square", signature: ["x-square-hmacsha256-signature", "x-square-signature"], path: /^square$/ },
  { name: "Discord", signature: ["x-signature-ed25519"], info: ["x-signature-timestamp"], path: /^discord$/ },
  { name: "Zoom", signature: ["x-zm-signature"], path: /^zoom$/ },
  { name: "Twitch", signature: ["twitch-eventsub-message-signature"], path: /^twitch$/ },
  { name: "HubSpot", signature: ["x-hubspot-signature", "x-hubspot-signature-v3"], path: /^hubspot$/ },
  { name: "Razorpay", signature: ["x-razorpay-signature"], path: /^razorpay$/ },
  { name: "Plaid", signature: ["plaid-verification"], path: /^plaid$/ },
  { name: "Vercel", signature: ["x-vercel-signature"], path: /^vercel$/ },
  { name: "Sentry", signature: ["sentry-hook-signature"], path: /^sentry$/ },
  { name: "Telegram", signature: ["x-telegram-bot-api-secret-token"], token: true, path: /^telegram$/ },
  { name: "Typeform", signature: ["typeform-signature"], path: /^typeform$/ },
  { name: "Calendly", signature: ["calendly-webhook-signature"], path: /^calendly$/ },
  { name: "Coinbase Commerce", signature: ["x-cc-webhook-signature"], path: /^coinbase$/ },
  { name: "Meta", signature: [], path: /^(?:facebook|meta|whatsapp|instagram|messenger)$/ },
  { name: "Mailgun", signature: [], path: /^mailgun$/ },
  { name: "Postmark", signature: [], path: /^postmark$/ },
  { name: "Lemon Squeezy", signature: [], path: /^lemon-?squeezy$/ },
  { name: "Mollie", signature: [], path: /^mollie$/ },
  { name: "Adyen", signature: [], path: /^adyen$/ },
  { name: "Braintree", signature: [], path: /^braintree$/ },
  { name: "Chargebee", signature: [], path: /^chargebee$/ },
  { name: "Bitbucket", signature: [], info: ["x-event-key"], path: /^bitbucket$/ },
  { name: "LINE", signature: ["x-line-signature"], path: /^line$/ },
  { name: "TikTok", signature: ["tiktok-signature"], path: /^tiktok$/ },
  { name: "X (Twitter)", signature: ["x-twitter-webhooks-signature"], path: /^twitter$/ },
  { name: "Intercom", signature: [], path: /^intercom$/ },
];

/** `x-hub-signature(-256)`: GitHub's, also Meta's and Intercom's — the path or another header decides. */
const HUB_SIGNATURE = new Set(["x-hub-signature", "x-hub-signature-256"]);

/** Provider SDK verification, by call spelling (each language's SDK listed together). */
const PROVIDER_VERIFY: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "Stripe", re: /(?:^|[.:])(?:constructEvent(?:Async)?|construct_event|ConstructEvent|parseEvent)$/ },
  { name: "Twilio", re: /(?:^|[.:])(?:validateRequest(?:WithBody)?|validate_request|RequestValidator)$/ },
  { name: "Slack", re: /(?:^|[.:])(?:verifySlackRequest|SignatureVerifier|is_valid_request|verifyRequestSignature)$/ },
  { name: "Shopify", re: /webhooks?\.validate$|(?:^|[.:])verifyWebhookHmac$/ },
  { name: "PayPal", re: /(?:^|[.:])(?:verifyWebhookSignature|verify_webhook_signature)$/ },
  { name: "GitHub", re: /(?:^|[.:])(?:verifyAndReceive|createNodeMiddleware)$|webhooks\.verify$/ },
];

/** A constant-time compare, or an HMAC computed — a signature checked by hand. */
const HAND_CHECK = /(?:^|[.:])(?:timingSafeEqual|compare_digest|hash_equals|ConstantTimeCompare|FixedTimeEquals|secure_compare|secureCompare|safeCompare|constant_time_compare|createHmac|HmacSHA256|hash_hmac)$|MessageDigest\.isEqual$|(?:^|[.:])(?:hmac|HMAC)\.(?:new|New|digest|hexdigest|Equal)$|^HMAC/;
/** A call or guard named for checking a signature. */
const NAMED_CHECK = /verif\w*(?:sign|webhook|hmac|request|event|payload)|(?:sign\w*|webhook|hmac)\w*verif|validat\w*(?:sign|webhook|hmac)|(?:sign\w*|webhook|hmac)\w*validat|is_?valid_?sig|check_?sig|signature_?(?:guard|middleware|check)/i;
/** An unfollowed call with one of these names might verify: the verdict is then unknown. */
const MIGHT_VERIFY = /verif|valid|sign|hmac|auth|secur|check|guard|webhook|hook|handle|process|dispatch|receive|middleware|construct|perform|enqueue|job|queue|delay|publish|emit/i;
/** A path segment naming a webhook receiver (`webhooks`, `stripe-webhook`, `hooks`) … */
const WEBHOOK_SEGMENT = /(?:^|[_-])(?:web-?hooks?|hooks?)(?:[_-]|$)/i;
/** … unless it names an action on one (`register_webhook`, `setup-webhook`). */
const MANAGES_WEBHOOK = /^(?:register|setup|set|create|delete|remove|update|add|test|list|enable|disable|subscribe|unsubscribe|configure|install)[_-]/i;
/** A guard, middleware or decorator that checks the sender's signature (`verify_meta_signature!`, `StripeSignatureGuard`), or the shared token it sends (`validate_token`). */
const isSignatureGuard = (g: string): boolean => NAMED_CHECK.test(g) || /(?:verif|validat|check)\w*token|token\w*(?:verif|valid|check)/i.test(g) || /webhook|signature|hmac/i.test(g.replace(/^@/, "").split(/[(\s]/)[0] ?? "");
/** Segments a provider's callback URL is spelled with beside its name (`/twilio/callback`, `/paypal/ipn`). */
const CALLBACK_SEGMENT = /^(?:callbacks?|events?|notify|notifications?|ipn|incoming|inbound|status|delivery[-_]?status)$/i;

const normalizeHeader = (h: string): string => h.toLowerCase().replace(/_/g, "-").replace(/^http-/, "");

type RouteRow = RouteInfo & { filePath: string; projectId?: string };

interface FnRef {
  fn: FunctionInfo;
  filePath: string;
}

export interface WebhookResult {
  webhooks: number;
  findings: SecurityIssue[];
}

export function attachWebhookRoutes(routes: RouteRow[], analyses: readonly FileAnalysis[]): WebhookResult {
  const byName = new Map<string, FnRef[]>();
  const projectOf = new Map<string, string>();
  for (const a of analyses) {
    projectOf.set(a.filePath, a.projectId ?? "root");
    const add = (fn: FunctionInfo) => (byName.get(fn.name) ?? byName.set(fn.name, []).get(fn.name)!).push({ fn, filePath: a.filePath });
    for (const fn of a.functions ?? []) add(fn);
    for (const c of a.classes ?? []) for (const m of c.methods ?? []) add(m);
  }
  /** A call's target among the project's functions: same file, else unique in the sub-project. */
  const follow = (call: CallInfo, fromFile: string, projectId: string): FnRef | null => {
    const leaf = call.name.split(/[.:]/).pop()!.replace(/\(.*$/, "");
    const refs = byName.get(leaf);
    if (!refs?.length) return null;
    const same = refs.filter((r) => r.filePath === fromFile);
    if (same.length === 1) return same[0]!;
    const inProject = refs.filter((r) => projectOf.get(r.filePath) === projectId);
    return inProject.length === 1 ? inProject[0]! : null;
  };

  let count = 0;
  const findings: SecurityIssue[] = [];
  for (const route of routes) {
    if (route.kind !== "api") continue;
    const method = (route.httpMethod ?? "").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") continue;
    const projectId = route.projectId ?? "root";
    const handler = handlerOf(route);
    // Headers read, calls made and guards applied — the route's own, then its handler's.
    const headers = new Set<string>();
    for (const p of route.params ?? []) if (p.binding === "header") headers.add(normalizeHeader(p.name));
    for (const p of handler?.fn.requestAccess ?? []) if (p.binding === "header") headers.add(normalizeHeader(p.name));
    const guards = [...(route.middleware ?? []), ...(route.auth?.policies ?? []), ...(handler?.fn.decorators ?? [])];

    // Walk the reach: calls, followed into project functions.
    const calls: string[] = [];
    let unknown = !handler && !!route.handler; // a named handler we could not find
    const visited = new Set<FunctionInfo>();
    const walk = (list: readonly CallInfo[], fromFile: string, depth: number) => {
      for (const c of list) {
        calls.push(c.name);
        const target = depth < 3 ? follow(c, fromFile, projectId) : null;
        if (target) {
          if (visited.has(target.fn)) continue;
          visited.add(target.fn);
          guards.push(...(target.fn.decorators ?? []));
          walk(target.fn.calls ?? [], target.filePath, depth + 1);
        } else if (MIGHT_VERIFY.test(c.name.split(/[.:]/).pop() ?? "") && !PROVIDER_VERIFY.some((p) => p.re.test(c.name)) && !HAND_CHECK.test(c.name)) {
          unknown = true;
        }
      }
    };
    walk(route.calls ?? [], route.filePath, 0);
    if (handler) {
      visited.add(handler.fn);
      walk(handler.fn.calls ?? [], handler.filePath, 1);
    }

    // Who sends it.
    let provider: string | undefined;
    let tokenRead: string | undefined;
    const segments = route.path.toLowerCase().split(/[/.]+/).filter(Boolean);
    const byPath = PROVIDERS.find((p) => segments.some((s) => p.path.test(s)));
    // The path alone says "webhook" only for a POST no user signs in to: a webhook
    // segment, or the provider's name beside a callback-style one. An
    // authenticated `/accounts/:id/webhooks` manages webhooks; it does not receive them.
    // (A guard that checks the sender's signature is not a sign-in.)
    const a = route.auth;
    const signedIn = !!a && !a.anonymous && a.policies.filter((p) => !isSignatureGuard(p)).length + a.roles.length + a.schemes.length > 0;
    const pathSays = method === "POST" && !signedIn && (segments.some((s) => WEBHOOK_SEGMENT.test(s) && !MANAGES_WEBHOOK.test(s)) || (!!byPath && segments.some((s) => CALLBACK_SEGMENT.test(s))));
    let signatureRead = false;
    for (const h of headers) {
      if (HUB_SIGNATURE.has(h)) {
        signatureRead = true;
        provider ??= byPath?.name ?? (headers.has("x-github-event") ? "GitHub" : undefined);
        continue;
      }
      const p = PROVIDERS.find((x) => x.signature.includes(h) || x.info?.includes(h));
      if (!p) continue;
      provider ??= p.name;
      if (p.signature.includes(h)) {
        signatureRead = true;
        if (p.token) tokenRead = h;
      }
    }
    const providerCall = calls.map((c) => ({ c, p: PROVIDER_VERIFY.find((v) => v.re.test(c)) })).find((x) => x.p);
    provider ??= providerCall?.p!.name;
    const isWebhook = signatureRead || !!providerCall || !!provider || pathSays;
    if (!isWebhook) continue;
    provider ??= byPath?.name;

    // How (whether) it checks the signature.
    // The concrete check first (a compare, an HMAC), then a helper named for one.
    const handCheck = calls.find((c) => HAND_CHECK.test(c)) ?? calls.find((c) => NAMED_CHECK.test(c.split(/[.:]/).pop() ?? ""));
    const guard = guards.find(isSignatureGuard);
    const via = providerCall?.c ?? handCheck ?? (guard ? guard.split("(")[0]!.trim() : undefined) ?? (tokenRead ? `${tokenRead} header` : undefined);
    // A shared-token sender is checked by a plain comparison no call shows: unread is unknown, not unverified.
    // A verifier named for its sender (`verify_slack_signature!`) names the sender.
    if (!provider && via) {
      const words = new Set(via.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).map((w) => w.toLowerCase()));
      provider = PROVIDERS.find((p) => words.has(p.name.toLowerCase()))?.name;
    }
    const tokenSender = PROVIDERS.find((p) => p.name === provider)?.token === true;
    const verified = via ? true : unknown || tokenSender ? undefined : false;
    route.webhook = { ...(provider ? { provider } : {}), ...(verified !== undefined ? { verified } : {}), ...(via ? { via } : {}) };
    count++;

    // The finding: a webhook from a named sender, everything reached, nothing checks it.
    if (verified === false && provider) {
      const label = `${method} ${route.path}`;
      findings.push({
        category: "webhook-unverified",
        severity: "high",
        message: `${label} receives ${provider} webhooks but nothing it reaches checks the signature${signatureRead ? " it reads" : ""}: anyone who finds the URL can post a forged event. Verify it with the provider's SDK or an HMAC compared in constant time.`,
        filePath: route.filePath,
        line: route.line,
        snippet: `${label}${route.handler ? ` → ${route.handler}` : ""}`,
        cwe: "CWE-345",
      });
    }
  }
  return { webhooks: count, findings };
}
