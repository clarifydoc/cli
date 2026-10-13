import type { SecurityIssue } from "../../../types/analysis.js";
import type { SecurityRule } from "../../../types/language-plugin.js";
import { CREDENTIAL_CONTEXT } from "../shared/security-context.js";

/**
 * JVM sinks and configuration that weaken an application — names, not taint:
 * each line is a construct that is unsafe on its own or almost always is.
 */
export const JVM_SECURITY_RULES: readonly SecurityRule[] = [
  {
    category: "deserialization",
    severity: "high",
    pattern: /\bnew\s+(?:ObjectInputStream|XMLDecoder)\s*\(/,
    message: "Java deserialization of a stream can run attacker-chosen code. Deserialize only trusted data, or use a data format with an allow-list.",
    priority: 50,
    excludeTest: true,
  },
  {
    category: "weak-crypto",
    severity: "medium",
    pattern: new RegExp(String.raw`\b(?:MessageDigest\.getInstance\s*\(\s*"(?:MD5|MD2|SHA-?1|md5|sha-?1)"(?=.*${CREDENTIAL_CONTEXT})|Cipher\.getInstance\s*\(\s*"(?:DES|DESede|RC2|RC4|Blowfish)\b|Cipher\.getInstance\s*\(\s*"[^"]*\/ECB\/)`),
    message: "Broken or weak cryptography (MD5/SHA-1 digest, DES/RC4 cipher, ECB mode). Use SHA-256+ and AES-GCM.",
    priority: 51,
    excludeTest: true,
  },
  {
    category: "command-injection",
    severity: "medium",
    pattern: /\bRuntime\.getRuntime\(\)\s*\.\s*exec\s*\(/,
    message: "Runtime.exec runs an OS command. Never build it from request data; prefer ProcessBuilder with a fixed argument list.",
    priority: 52,
  },
  {
    category: "insecure-config",
    severity: "high",
    pattern: /\.csrf\s*\(\s*\)\s*\.\s*disable\s*\(|\bcsrf\s*\(\s*(?:AbstractHttpConfigurer::disable|\w+\s*->\s*\w+\.disable\(\))|\bcsrf\s*\{\s*(?:it\.)?disable\(\)/,
    message: "CSRF protection is disabled. Keep it on for any endpoint a browser session can reach.",
    priority: 53,
    excludeTest: true,
  },
  {
    category: "insecure-config",
    severity: "medium",
    pattern: /["']\/\*\*["']\s*\)\s*\.\s*permitAll\s*\(/,
    message: "Every path is permitted without authentication (\"/**\").permitAll().",
    priority: 54,
    excludeTest: true,
  },
  {
    category: "insecure-config",
    severity: "high",
    pattern: /\b(?:ALLOW_ALL_HOSTNAME_VERIFIER|NoopHostnameVerifier|TrustAllStrategy)\b|setHostnameVerifier\s*\(\s*\([^)]*\)\s*->\s*true/,
    message: "TLS certificate or hostname verification is turned off.",
    priority: 55,
    excludeTest: true,
  },
];

/** XML parser factories that resolve external entities unless told not to. */
const XML_FACTORY_RE = /\b(DocumentBuilderFactory|SAXParserFactory|XMLInputFactory|TransformerFactory|SchemaFactory)\s*\.\s*newInstance\s*\(/;
/** Any of the switches that harden them. */
const XML_HARDENED_RE = /disallow-doctype-decl|external-general-entities|FEATURE_SECURE_PROCESSING|ACCESS_EXTERNAL_DTD|IS_SUPPORTING_EXTERNAL_ENTITIES|SUPPORT_DTD|setExpandEntityReferences\s*\(\s*false/;

/**
 * XXE: a file that creates an XML parser factory and never hardens one. Whole
 * file, because the hardening is a later `setFeature` call, not the line itself.
 */
export function jvmSecurityPostScan(lines: string[], filePath: string): SecurityIssue[] {
  const text = lines.join("\n");
  if (!XML_FACTORY_RE.test(text) || XML_HARDENED_RE.test(text)) return [];
  const i = lines.findIndex((l) => XML_FACTORY_RE.test(l) && !l.trimStart().startsWith("//"));
  if (i < 0) return [];
  return [{
    category: "xxe",
    severity: "high",
    message: `${XML_FACTORY_RE.exec(lines[i]!)![1]} is created without disabling DTDs / external entities (XXE). Set disallow-doctype-decl or FEATURE_SECURE_PROCESSING.`,
    filePath,
    line: i + 1,
    snippet: lines[i]!.trim().slice(0, 100),
  }];
}
