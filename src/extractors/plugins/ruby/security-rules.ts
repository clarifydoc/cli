import type { SecurityRule } from "../../../types/language-plugin.js";
import { CREDENTIAL_CONTEXT } from "../shared/security-context.js";

/**
 * Ruby sinks and configuration that weaken an application (see the JVM rules
 * for the stance). Not CSRF: `skip_before_action :verify_authenticity_token`
 * is how a token-authenticated API controller is meant to look.
 */
export const RUBY_SECURITY_RULES: readonly SecurityRule[] = [
  {
    category: "deserialization",
    severity: "high",
    pattern: /\bMarshal\.load\s*\(|\bYAML\.(?:load|unsafe_load)\s*\((?![^)]*permitted_classes)/,
    message: "Marshal.load / YAML.load can instantiate attacker-chosen objects. Use YAML.safe_load or JSON.",
    priority: 50,
    excludeTest: true,
  },
  {
    category: "insecure-config",
    cwe: "CWE-295",
    severity: "high",
    pattern: /verify_mode\s*(?:=|:|=>)\s*OpenSSL::SSL::VERIFY_NONE/,
    message: "TLS certificate verification is turned off (VERIFY_NONE).",
    priority: 51,
    excludeTest: true,
  },
  {
    category: "weak-crypto",
    severity: "medium",
    pattern: new RegExp(String.raw`\bDigest::(?:MD5|SHA1)\b(?=.*${CREDENTIAL_CONTEXT})|OpenSSL::Cipher\.new\s*\(\s*["'](?:des|rc4|bf|DES|RC4|BF)`),
    message: "Broken or weak cryptography (MD5/SHA-1, DES/RC4/Blowfish). Use SHA-256+ and AES-GCM.",
    priority: 53,
    excludeTest: true,
  },
];
