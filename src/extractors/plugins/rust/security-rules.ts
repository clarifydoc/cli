import type { SecurityRule } from "../../../types/language-plugin.js";
import { CREDENTIAL_CONTEXT } from "../shared/security-context.js";

/** Rust configuration and sinks that weaken an application (the stance of the Go and JVM rules). */
export const RUST_SECURITY_RULES: readonly SecurityRule[] = [
  {
    category: "insecure-config",
    cwe: "CWE-295",
    severity: "high",
    // reqwest / native-tls builders.
    pattern: /\.danger_accept_invalid_(?:certs|hostnames)\s*\(\s*true\s*\)/,
    message: "TLS certificate or host name verification is turned off (danger_accept_invalid_*).",
    priority: 50,
    excludeTest: true,
  },
  {
    category: "weak-crypto",
    severity: "medium",
    // The `md5` crate's `compute`, RustCrypto's `Md5`/`Sha1` hashers — on a credential's path only (a checksum is no weakness).
    pattern: new RegExp(String.raw`(?:\bmd5::compute|\b(?:Md5|Sha1)::(?:new|digest))\s*\((?=.*${CREDENTIAL_CONTEXT})`),
    message: "Broken cryptography (MD5/SHA-1) on a credential. Use a password hash (argon2, bcrypt) or SHA-256+.",
    priority: 51,
    excludeTest: true,
  },
  {
    category: "command-injection",
    severity: "medium",
    // The script after `-c` is a value, not text written in place (`.arg("-c").arg("command -v rustfmt")` runs nothing it is handed).
    pattern: /Command::new\s*\(\s*"(?:\/bin\/)?(?:ba|z)?sh"\s*\)\s*\.\s*args?\s*\(\s*(?:\[\s*|&\s*\[\s*|vec!\s*\[\s*)?"-c"(?:\s*\)\s*\.\s*args?\s*\(|\s*,)\s*(?!["\s])/g,
    multiline: true,
    message: "A command runs through the shell (sh -c). Never build it from request data; pass arguments directly.",
    priority: 52,
    excludeTest: true,
  },
];
