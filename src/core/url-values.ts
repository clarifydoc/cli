import { trimTrailingSlashes } from "../extractors/plugins/shared/path-utils.js";

/**
 * Configuration and environment values that are addresses — the only values
 * the call-origin pass keeps from config files and deployment manifests.
 * Everything else (connection strings, keys, flags) is dropped unread, and an
 * address loses any `user:password@` it carries, so no secret reaches an
 * artifact through this path.
 */

/** `http://user:pw@orders:8080/x` → `http://orders:8080/x`; `orders:8080` stays; null for a non-address or a template. */
export function urlValue(raw: string): string | null {
  const v = raw.trim();
  if (!v || /\s/.test(v) || v.includes("${") || v.includes("{{")) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/?#]+)([\s\S]*)$/i.exec(v);
  if (scheme) return `${scheme[1]!.toLowerCase()}://${scheme[2]}${scheme[3]}`;
  return /^[a-z0-9.-]+:\d{1,5}(?:\/\S*)?$/i.test(v) ? v : null;
}

export interface ParsedAddress {
  /** Lowercased host. */
  host: string;
  port?: number;
  /** Path the base carries (`/inventory`), no trailing slash; "" for none. */
  path: string;
  scheme?: string;
}

/** Host, port and path of an address `urlValue` kept. */
export function parseAddress(url: string): ParsedAddress | null {
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\[[^\]]+\]|[^/:?#]+)(?::(\d{1,5}))?([^?#]*)/i.exec(url.trim());
  if (!m || !m[2]) return null;
  const scheme = m[1]?.toLowerCase();
  const port = m[3] ? Number(m[3]) : scheme === "http" ? 80 : scheme === "https" ? 443 : undefined;
  return {
    host: m[2].toLowerCase(),
    ...(port !== undefined ? { port } : {}),
    path: trimTrailingSlashes(m[4] ?? ""),
    ...(scheme ? { scheme } : {}),
  };
}

const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\]|\+|\*)$/;

/** The machine itself: `localhost`, `127.0.0.1`, and Kestrel's `+`/`*` wildcards. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host.toLowerCase());
}
