import type { SecurityRule } from "../../../types/language-plugin.js";
import { CREDENTIAL_CONTEXT } from "../shared/security-context.js";

/** Go sinks and configuration that weaken an application (see the JVM rules for the stance). */
export const GO_SECURITY_RULES: readonly SecurityRule[] = [
  {
    category: "insecure-config",
    severity: "high",
    pattern: /InsecureSkipVerify\s*:\s*true\b/,
    message: "TLS certificate verification is turned off (InsecureSkipVerify).",
    priority: 50,
    excludeTest: true,
  },
  {
    category: "weak-crypto",
    severity: "medium",
    pattern: new RegExp(String.raw`\b(?:md5|sha1)\.(?:New|Sum)\s*\((?=.*${CREDENTIAL_CONTEXT})|\bdes\.New(?:TripleDES)?Cipher\s*\(|\brc4\.NewCipher\s*\(`),
    message: "Broken or weak cryptography (MD5/SHA-1, DES/RC4). Use SHA-256+ and AES-GCM.",
    priority: 51,
    excludeTest: true,
  },
  {
    category: "command-injection",
    severity: "medium",
    pattern: /exec\.Command(?:Context)?\s*\((?:[^,]*,\s*)?"(?:ba|z)?sh"\s*,\s*"-c"/,
    message: "A command runs through the shell (sh -c). Never build it from request data; pass arguments directly.",
    priority: 52,
    excludeTest: true,
  },
];
