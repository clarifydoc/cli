import type { SecurityRule } from "../../../types/language-plugin.js";
import { CREDENTIAL_CONTEXT } from "../shared/security-context.js";

/**
 * Swift sinks that weaken an application. A session delegate answering a server-trust challenge with
 * `.useCredential` is not flagged: a pattern cannot tell trusting everything from pinning a certificate first.
 */
export const SWIFT_SECURITY_RULES: readonly SecurityRule[] = [
  {
    category: "weak-crypto",
    severity: "medium",
    // CryptoKit names them itself (`Insecure.MD5`); CommonCrypto's `CC_MD5` / `CC_SHA1`. On a credential's path only.
    pattern: new RegExp(String.raw`(?:\bInsecure\.(?:MD5|SHA1)\.hash\s*\(|\bCC_(?:MD5|SHA1)\s*\()(?=.*${CREDENTIAL_CONTEXT})`),
    message: "Broken cryptography (MD5/SHA-1) on a credential. Use a password hash or SHA-256+.",
    priority: 51,
    excludeTest: true,
  },
];
