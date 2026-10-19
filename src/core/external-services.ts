import type { DataSourceInfo } from "../types/analysis.js";

type ApiCall = DataSourceInfo & { filePath: string };

/**
 * The third-party service an external host belongs to — `api.stripe.com` is
 * Stripe — so "this code calls api.stripe.com" reads as "this code takes
 * payments through Stripe". Hosts only: a call made through a vendor's SDK
 * is no api-call and is not seen here. A host not in the table stays named
 * by its host.
 *
 * Patterns match a whole host (`api.stripe.com`) or any subdomain of a
 * suffix (`.twilio.com`); the first match wins, so specific entries come
 * before a vendor's catch-all.
 */
const SERVICES: ReadonlyArray<readonly [string, string]> = [
  // Payments
  ["api.stripe.com", "Stripe"], [".stripe.com", "Stripe"],
  ["api-m.paypal.com", "PayPal"], ["api-m.sandbox.paypal.com", "PayPal"], [".paypal.com", "PayPal"],
  [".braintreegateway.com", "Braintree"], [".adyen.com", "Adyen"], [".adyenpayments.com", "Adyen"],
  ["connect.squareup.com", "Square"], [".squareup.com", "Square"], [".plaid.com", "Plaid"],
  [".klarna.com", "Klarna"], [".mollie.com", "Mollie"], [".razorpay.com", "Razorpay"],
  // Messaging and mail
  ["api.sendgrid.com", "SendGrid"], [".mailgun.net", "Mailgun"], ["api.postmarkapp.com", "Postmark"],
  ["api.resend.com", "Resend"], [".api.mailchimp.com", "Mailchimp"], [".mandrillapp.com", "Mailchimp Transactional"],
  [".twilio.com", "Twilio"], [".vonage.com", "Vonage"], ["rest.nexmo.com", "Vonage"],
  ["hooks.slack.com", "Slack"], ["slack.com", "Slack"], ["discord.com", "Discord"], ["api.telegram.org", "Telegram"],
  ["fcm.googleapis.com", "Firebase Cloud Messaging"], [".pusher.com", "Pusher"], ["api.pusherapp.com", "Pusher"],
  ["api.intercom.io", "Intercom"],
  // AI
  ["api.openai.com", "OpenAI"], ["api.anthropic.com", "Anthropic"], ["generativelanguage.googleapis.com", "Google Gemini"],
  [".openai.azure.com", "Azure OpenAI"], ["api.mistral.ai", "Mistral"], ["api.cohere.ai", "Cohere"], ["api.cohere.com", "Cohere"],
  ["api-inference.huggingface.co", "Hugging Face"], ["api.replicate.com", "Replicate"], ["api.groq.com", "Groq"],
  // Identity
  [".auth0.com", "Auth0"], [".okta.com", "Okta"], ["login.microsoftonline.com", "Microsoft Entra ID"],
  ["oauth2.googleapis.com", "Google OAuth"], ["accounts.google.com", "Google OAuth"], [".clerk.com", "Clerk"],
  ["securetoken.googleapis.com", "Firebase Auth"], ["identitytoolkit.googleapis.com", "Firebase Auth"],
  // Developer platforms
  ["api.github.com", "GitHub"], ["uploads.github.com", "GitHub"], ["gitlab.com", "GitLab"], [".atlassian.net", "Atlassian"],
  ["api.bitbucket.org", "Bitbucket"], ["api.vercel.com", "Vercel"], ["api.netlify.com", "Netlify"],
  ["api.heroku.com", "Heroku"], ["api.digitalocean.com", "DigitalOcean"], ["api.cloudflare.com", "Cloudflare"],
  ["sentry.io", "Sentry"], [".sentry.io", "Sentry"],
  // Cloud
  [".amazonaws.com", "AWS"], [".blob.core.windows.net", "Azure Storage"], [".azurewebsites.net", "Azure App Service"],
  ["graph.microsoft.com", "Microsoft Graph"], ["maps.googleapis.com", "Google Maps"], ["storage.googleapis.com", "Google Cloud Storage"],
  [".firebaseio.com", "Firebase Realtime Database"], ["firestore.googleapis.com", "Cloud Firestore"], [".googleapis.com", "Google APIs"],
  [".supabase.co", "Supabase"],
  // Content, maps, analytics, CRM
  ["api.mapbox.com", "Mapbox"], ["cdn.contentful.com", "Contentful"], ["api.contentful.com", "Contentful"], [".sanity.io", "Sanity"],
  ["api.cloudinary.com", "Cloudinary"], [".algolia.net", "Algolia"], [".algolianet.com", "Algolia"],
  ["api.segment.io", "Segment"], ["api.mixpanel.com", "Mixpanel"], ["api2.amplitude.com", "Amplitude"],
  ["api.hubapi.com", "HubSpot"], [".salesforce.com", "Salesforce"], [".force.com", "Salesforce"], [".zendesk.com", "Zendesk"],
  [".myshopify.com", "Shopify"], ["api.notion.com", "Notion"], ["api.airtable.com", "Airtable"],
  ["api.dropboxapi.com", "Dropbox"], ["content.dropboxapi.com", "Dropbox"], ["api.box.com", "Box"],
  ["graph.facebook.com", "Meta Graph API"], ["api.twitter.com", "X (Twitter)"], ["api.x.com", "X (Twitter)"],
  ["api.spotify.com", "Spotify"], ["api.openweathermap.org", "OpenWeather"], ["hcaptcha.com", "hCaptcha"],
];

export function serviceForHost(host: string): string | undefined {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  for (const [pattern, name] of SERVICES) {
    if (pattern.startsWith(".") ? h.endsWith(pattern) : h === pattern) return name;
  }
  return undefined;
}

/** Every external host the code calls, grouped by the service it belongs to (or by itself). */
export interface ExternalService {
  /** The service (`Stripe`), or the host itself when the table does not know it. */
  name: string;
  known: boolean;
  hosts: string[];
  calls: number;
  files: string[];
}

export function externalServices(calls: readonly ApiCall[]): ExternalService[] {
  const by = new Map<string, ExternalService>();
  for (const c of calls) {
    const o = c.origin;
    if (!o?.external || !o.host) continue;
    const name = o.service ?? o.host;
    const s = by.get(name) ?? { name, known: !!o.service, hosts: [], calls: 0, files: [] };
    if (!s.hosts.includes(o.host)) s.hosts.push(o.host);
    if (!s.files.includes(c.filePath)) s.files.push(c.filePath);
    s.calls++;
    by.set(name, s);
  }
  return [...by.values()]
    .map((s) => ({ ...s, hosts: s.hosts.sort(), files: s.files.sort() }))
    .sort((a, b) => Number(b.known) - Number(a.known) || b.calls - a.calls || (a.name < b.name ? -1 : 1));
}
