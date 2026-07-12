import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { renderHelmTemplate, collectK8sManifests } from "./deployment-k8s.js";
import { detectDeployment } from "./deployment.js";
import type { SubProject } from "../types/analysis.js";

// ─── Helm template rendering ────────────────────────────────────────────────

describe("renderHelmTemplate", () => {
  const chart = {
    name: "shop",
    values: { image: { repository: "reg.io/shop/api", tag: "1.4" }, replicaCount: "2" } as any,
  };

  it("resolves .Values paths, helpers, and drops control-flow lines", () => {
    const rendered = renderHelmTemplate(
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        '  name: {{ include "shop.fullname" . }}',
        "spec:",
        "  {{- if .Values.autoscaling.enabled }}",
        "  replicas: {{ .Values.replicaCount }}",
        "  {{- end }}",
        "  template:",
        "    spec:",
        "      containers:",
        "        - name: api",
        '          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"',
      ].join("\n"),
      chart,
    );
    expect(rendered).toContain("name: shop");
    expect(rendered).toContain('image: "reg.io/shop/api:1.4"');
    expect(rendered).toContain("replicas: 2");
    expect(rendered).not.toContain("{{");
  });

  it("falls back to | default literals and degrades unknown exprs to empty", () => {
    const rendered = renderHelmTemplate(
      'port: {{ .Values.service.port | default "8080" }}\nsa: {{ .Values.nothing }}',
      chart,
    );
    expect(rendered).toContain("port: 8080");
    expect(rendered).toContain("sa: ");
  });
});

// ─── k8s manifests → deployment model ───────────────────────────────────────

const sub = (id: string, name: string, root: string): SubProject =>
  ({ id, name, root, kind: "dotnet", markers: [] } as SubProject);

describe("k8s deployment topology", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rdoc-k8s-"));
    await mkdir(join(root, "deploy"), { recursive: true });

    // Deployment + Service (different names — the Service is the DNS identity)
    // + ConfigMap env, all in one multi-doc manifest.
    await writeFile(
      join(root, "deploy", "user-api.yaml"),
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: user-api-deployment",
        "spec:",
        "  template:",
        "    metadata:",
        "      labels:",
        "        app: user-api",
        "    spec:",
        "      containers:",
        "        - name: api",
        "          image: reg.io/acme/user-api:2.0",
        "          envFrom:",
        "            - configMapRef:",
        "                name: user-api-config",
        "          env:",
        "            - name: ConnectionString",
        "              value: Host=pg;Database=users",
        "---",
        "apiVersion: v1",
        "kind: Service",
        "metadata:",
        "  name: user-svc",
        "spec:",
        "  selector:",
        "    app: user-api",
        "---",
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: user-api-config",
        "data:",
        "  LOG_LEVEL: debug",
      ].join("\n"),
    );

    // A second workload whose env URL points at the FIRST one's Service name.
    await writeFile(
      join(root, "deploy", "order-api.yaml"),
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: order-api",
        "spec:",
        "  template:",
        "    spec:",
        "      containers:",
        "        - name: api",
        "          image: reg.io/acme/order-api:1.1",
        "          env:",
        "            - name: USERS_API_URL",
        "              value: http://user-svc:8080",
        "---",
        "apiVersion: apps/v1",
        "kind: StatefulSet",
        "metadata:",
        "  name: pg",
        "spec:",
        "  template:",
        "    spec:",
        "      containers:",
        "        - name: postgres",
        "          image: postgres:16",
        "          env:",
        "            - name: POSTGRES_DB",
        "              value: users",
      ].join("\n"),
    );

    // Noise: a CI-style yaml that must not parse as a workload.
    await writeFile(join(root, "deploy", "lint.yaml"), "rules:\n  semi: error\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("collects workloads with ConfigMap-merged env and Service aliases", async () => {
    const k8s = (await collectK8sManifests(root))!;
    expect(k8s).toBeDefined();
    expect(k8s.files).toHaveLength(2);

    const all = k8s.groups.flat();
    const user = all.find((s) => s.name === "user-api-deployment")!;
    expect(user.image).toBe("reg.io/acme/user-api:2.0");
    expect(user.env.LOG_LEVEL).toBe("debug"); // envFrom configMapRef merged
    expect(user.env.ConnectionString).toBe("Host=pg;Database=users");

    expect(k8s.aliases.get("user-svc")).toBe("user-api-deployment");
  });

  it("feeds detectDeployment: app/datastore classification, URL edge via Service alias, db edge", async () => {
    const model = (await detectDeployment(root, {
      subProjects: [sub("p1", "UserApi", "user-api"), sub("p2", "OrderApi", "order-api")],
    }))!;
    expect(model).toBeDefined();

    const names = model.services.map((s) => s.name).sort();
    expect(names).toEqual(["order-api", "pg", "user-api-deployment"]);
    expect(model.services.find((s) => s.name === "pg")!.kind).toBe("datastore");
    expect(model.services.find((s) => s.name === "pg")!.hostedDatabases).toContain("users");

    // order-api → user-api via http://user-svc (Service alias resolution).
    expect(model.edges).toContainEqual(
      expect.objectContaining({ from: "order-api", to: "user-api-deployment", kind: "http" }),
    );
    // user-api → pg via its literal connection string naming Database=users.
    expect(model.edges).toContainEqual(
      expect.objectContaining({ from: "user-api-deployment", to: "pg", kind: "db", label: "users" }),
    );
  });
});
