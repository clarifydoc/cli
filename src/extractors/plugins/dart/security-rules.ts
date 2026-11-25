import type { SecurityRule } from "../../../types/language-plugin.js";
import { CREDENTIAL_CONTEXT } from "../shared/security-context.js";

/** Dart configuration and sinks that weaken an application (the stance of the Go and JVM rules). */
export const DART_SECURITY_RULES: readonly SecurityRule[] = [
  {
    category: "insecure-config",
    cwe: "CWE-295",
    severity: "high",
    // `HttpClient()..badCertificateCallback = (cert, host, port) => true`, or a block returning true.
    pattern: /badCertificateCallback\s*=\s*\([^)]*\)\s*(?:=>\s*true\b|\{\s*return\s+true\s*;\s*\})/,
    message: "Every TLS certificate is accepted (badCertificateCallback returns true).",
    priority: 50,
    excludeTest: true,
  },
  {
    category: "weak-crypto",
    severity: "medium",
    // package:crypto's `md5` / `sha1` — on a credential's path only.
    pattern: new RegExp(String.raw`\b(?:md5|sha1)\.convert\s*\((?=.*${CREDENTIAL_CONTEXT})`),
    message: "Broken cryptography (MD5/SHA-1) on a credential. Use a password hash or SHA-256+.",
    priority: 51,
    excludeTest: true,
  },
  {
    category: "command-injection",
    severity: "medium",
    // The script after `-c` is a value, not text written in place.
    pattern: /Process\.(?:run|runSync|start)\s*\(\s*['"](?:\/bin\/)?(?:ba|z)?sh['"]\s*,\s*(?:const\s*)?\[\s*['"]-c['"]\s*,\s*(?!['"\s])/,
    message: "A command runs through the shell (sh -c). Never build it from user data; pass arguments directly.",
    priority: 52,
    excludeTest: true,
  },
];
