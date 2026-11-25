import type { SecurityRule } from "../../../types/language-plugin.js";
import { CREDENTIAL_CONTEXT } from "../shared/security-context.js";

/** Scala sinks that weaken an application (the stance of the JVM rules). */
export const SCALA_SECURITY_RULES: readonly SecurityRule[] = [
  {
    category: "deserialization",
    severity: "high",
    pattern: /\bnew\s+ObjectInputStream\s*\(/,
    message: "Java deserialization of a stream can run attacker-chosen code. Deserialize only trusted data, or use a data format with an allow-list.",
    priority: 50,
    excludeTest: true,
  },
  {
    category: "weak-crypto",
    severity: "medium",
    pattern: new RegExp(String.raw`\bMessageDigest\.getInstance\s*\(\s*"(?:MD5|MD2|SHA-?1|md5|sha-?1)"(?=.*${CREDENTIAL_CONTEXT})`),
    message: "Broken cryptography (MD5/SHA-1) on a credential. Use a password hash (bcrypt, argon2) or SHA-256+.",
    priority: 51,
    excludeTest: true,
  },
  {
    category: "command-injection",
    severity: "medium",
    // `Process(Seq("sh", "-c", cmd))`, `Seq("bash", "-c", cmd).!`.
    // The script after `-c` is a value, not text written in place.
    pattern: /\bSeq\s*\(\s*"(?:\/bin\/)?(?:ba|z)?sh"\s*,\s*"-c"\s*,\s*(?!["\s])/,
    message: "A command runs through the shell (sh -c). Never build it from request data; pass arguments directly.",
    priority: 52,
    excludeTest: true,
  },
];
