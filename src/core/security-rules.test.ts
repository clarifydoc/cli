import { describe, it, expect } from "vitest";
import { scanSecurity } from "./security-scanner.js";
import type { Language } from "../types/analysis.js";

/**
 * Each language's sink and configuration rules, as pairs: a line that must be
 * reported (with its category) and a near miss that must not.
 */
const CASES: Array<[Language, string, string, string | null]> = [
  // [language, file, line, category or null]
  ["java", "src/A.java", "ObjectInputStream in = new ObjectInputStream(socket.getInputStream());", "deserialization"],
  ["java", "src/A.java", 'MessageDigest md = MessageDigest.getInstance("MD5"); md.update(password);', "weak-crypto"],
  ["java", "src/A.java", 'MessageDigest md = MessageDigest.getInstance("MD5"); md.update(fileBytes);', null],
  ["java", "src/A.java", 'MessageDigest md = MessageDigest.getInstance("SHA-256");', null],
  ["java", "src/A.java", "http.csrf().disable();", "insecure-config"],
  ["java", "src/A.java", "http.csrf(AbstractHttpConfigurer::disable);", "insecure-config"],
  ["kotlin", "src/A.kt", "http.csrf { it.disable() }", "insecure-config"],
  ["java", "src/A.java", '.requestMatchers("/**").permitAll()', "insecure-config"],
  ["java", "src/A.java", '.requestMatchers("/public/**").permitAll()', null],
  ["csharp", "src/A.cs", "var f = new BinaryFormatter();", "deserialization"],
  ["csharp", "src/A.cs", "TypeNameHandling = TypeNameHandling.Auto,", "deserialization"],
  ["csharp", "src/A.cs", "TypeNameHandling = TypeNameHandling.None,", null],
  ["csharp", "src/A.cs", "settings.DtdProcessing = DtdProcessing.Parse;", "xxe"],
  ["csharp", "src/A.cs", "var hash = MD5.Create().ComputeHash(passwordBytes);", "weak-crypto"],
  ["csharp", "src/A.cs", "using var md5 = MD5.Create();", null],
  ["csharp", "src/A.cs", "var des = DES.Create();", "weak-crypto"],
  ["csharp", "src/A.cs", "new XmlReaderSettings { DtdProcessing = DtdProcessing.Parse, XmlResolver = null }", null],
  ["csharp", "src/A.cs", "handler.ServerCertificateCustomValidationCallback = (m, c, ch, e) => true;", "insecure-config"],
  ["php", "src/a.php", "$data = unserialize($_COOKIE['cart']);", "deserialization"],
  ["php", "src/a.php", "$data = unserialize($raw, ['allowed_classes' => false]);", null],
  ["php", "src/a.php", "$out = shell_exec('convert ' . $file);", "command-injection"],
  ["php", "src/a.php", "$pdo->exec($sql);", null],
  ["php", "src/a.php", "public static function unserialize(object $json): self", null],
  ["php", "src/a.php", "curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);", "insecure-config"],
  ["ruby", "app/a.rb", "obj = Marshal.load(params[:blob])", "deserialization"],
  ["ruby", "app/a.rb", "cfg = YAML.safe_load(text)", null],
  ["ruby", "app/a.rb", "http.verify_mode = OpenSSL::SSL::VERIFY_NONE", "insecure-config"],
  ["ruby", "app/a.rb", "skip_before_action :verify_authenticity_token", null],
  ["ruby", "app/a.rb", "hash = Digest::MD5.hexdigest(email)", null],
  ["go", "pkg/a.go", "tls := &tls.Config{InsecureSkipVerify: true}", "insecure-config"],
  ["go", "pkg/a.go", 'cmd := exec.Command("sh", "-c", script)', "command-injection"],
  ["go", "pkg/a.go", 'cmd := exec.Command("git", "status")', null],
  ["python", "app/a.py", "cfg = yaml.load(stream)", "deserialization"],
  ["python", "app/a.py", "cfg = yaml.load(stream, Loader=yaml.SafeLoader)", null],
  ["python", "app/a.py", "h = hashlib.md5(password.encode())", "weak-crypto"],
  ["python", "app/a.py", "etag = hashlib.md5(body)", null],
  ["python", "app/a.py", "h = hashlib.md5(data, usedforsecurity=False)", null],
  ["python", "mysite/settings.py", "DEBUG = True", "insecure-config"],
  ["python", "app/flags.py", "DEBUG = True", null],
  ["python", "app/a.py", "r = requests.get(url, verify=False)", "insecure-config"],
  ["python", "app/a.py", 'claims = jwt.decode(token, options={"verify_signature": False})', "insecure-config"],
  ["python", "app/a.py", "# never pass verify=False here", null],
  ["typescript", "src/a.ts", "app.use(cors({ origin: '*', credentials: true }));", "insecure-config"],
  ["typescript", "src/a.ts", "app.use(cors({ origin: 'https://app.example.com', credentials: true }));", null],
  ["typescript", "src/a.ts", "const agent = new https.Agent({ rejectUnauthorized: false });", "insecure-config"],
  ["typescript", "src/a.ts", "const h = crypto.createHash('md5').update(password).digest('hex');", "weak-crypto"],
  ["typescript", "src/a.ts", "const h = crypto.createHash('md5').update(content).digest('hex');", null],
  ["go", "pkg/a.go", "k := md5.Sum([]byte(setting.SecretKey))", "weak-crypto"],
  ["go", "pkg/a.go", "h := sha1.New()", null],
  ["go", "pkg/a.go", "k := md5.Sum([]byte(cacheKey))", null],
  ["typescript", "src/a.ts", "const id = crypto.createHash('sha1').update(design).digest('hex');", null],
];

describe("per-language sink and configuration rules", () => {
  for (const [language, file, line, category] of CASES) {
    it(`${language}: ${category ?? "no finding"} — ${line}`, () => {
      const got = scanSecurity(line, file, language)
        .filter((i) => i.category !== "todo-fixme" && i.category !== "debug-statement")
        .map((i) => i.category);
      expect(got).toEqual(category ? [category] : []);
    });
  }

  it("Java: XXE when an XML factory is never hardened", () => {
    const open = ["DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();", "Document d = f.newDocumentBuilder().parse(in);"].join("\n");
    expect(scanSecurity(open, "src/X.java", "java").map((i) => [i.category, i.line])).toEqual([["xxe", 1]]);
    const hardened = [open, 'f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);'].join("\n");
    expect(scanSecurity(hardened, "src/X.java", "java")).toEqual([]);
  });

  it("C#: CORS any origin only matters with credentials", () => {
    const risky = ["policy.AllowAnyOrigin()", "      .AllowAnyHeader()", "      .AllowCredentials();"].join("\n");
    expect(scanSecurity(risky, "src/Startup.cs", "csharp").map((i) => [i.category, i.line])).toEqual([["insecure-config", 1]]);
    expect(scanSecurity("policy.AllowAnyOrigin().AllowAnyHeader();", "src/Startup.cs", "csharp")).toEqual([]);
  });
});
