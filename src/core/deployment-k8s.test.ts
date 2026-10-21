import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { chartDefines, renderHelmTemplate, collectK8sManifests } from "./deployment-k8s.js";
import { composeImage, detectDeployment, isImageRef } from "./deployment.js";
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
        "  {{- if not .Values.autoscaling.enabled }}",
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

  it("decides if/else against the values and drops the branch not taken", () => {
    const rendered = renderHelmTemplate(
      [
        "{{- if .Values.debug.enabled }}",
        "image: reg.io/shop/api-debug:1.4",
        "{{- else if eq .Values.flavor \"slim\" }}",
        "image: reg.io/shop/api-slim:1.4",
        "{{- else }}",
        "image: reg.io/shop/api:1.4",
        "{{- end }}",
        '{{- define "shop.unused" }}',
        "kind: NotOutput",
        "{{- end }}",
      ].join("\n"),
      { name: "shop", values: { debug: { enabled: "false" }, flavor: "slim" } as any },
    );
    expect(rendered.split("\n")).toEqual(["image: reg.io/shop/api-slim:1.4"]);
  });

  it("an image built from anything not known exactly is left out, never guessed", () => {
    const chart = { name: "cx", appVersion: "3.4.5", values: { image: { repository: "nginx", tag: "" }, sidecars: [] } as any };
    const render = (line: string) => renderHelmTemplate(line, chart).trim();
    // `| default` with a non-literal operand, and `.Chart.AppVersion`.
    expect(render('image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"')).toBe('image: "nginx:3.4.5"');
    expect(render('image: {{ printf "%s:%s" .Values.image.repository .Chart.AppVersion | quote }}')).toBe('image: "nginx:3.4.5"');
    // A named template is a stand-in (the chart name), so no image — it used to come out as `cx`.
    expect(render('image: {{ include "cx.image" . }}')).toBe("image:");
    // Under an undecidable condition, or `.` inside range: no image.
    expect(renderHelmTemplate("{{- if and .Values.a .Values.b }}\nimage: x/y:1\n{{- end }}", chart).trim()).toBe("image:");
    expect(renderHelmTemplate("{{- range .Values.sidecars }}\n- image: {{ .image }}\n{{- end }}", chart).trim()).toBe("- image:");
    // Names still take the stand-in.
    expect(render('name: {{ include "cx.fullname" . }}')).toBe("name: cx");
  });

  it("isImageRef refuses empty tags, leftovers and variables", () => {
    expect(isImageRef("nginx:3.4.5")).toBe(true);
    expect(isImageRef("ghcr.io/acme/cx@sha256:abc")).toBe(true);
    expect(isImageRef("nginx:")).toBe(false);
    expect(isImageRef(":1.0")).toBe(false);
    expect(isImageRef("${API_IMAGE}")).toBe(false);
    expect(isImageRef("{{ .Values.image }}")).toBe(false);
    expect(isImageRef("")).toBe(false);
  });

  it("a compose image takes its ${X:-default}; a bare ${X} names none", () => {
    expect(composeImage("${API_IMAGE:-acme/api:1.0}")).toBe("acme/api:1.0");
    expect(composeImage("acme/api:${TAG-2.1}")).toBe("acme/api:2.1");
    expect(composeImage("${API_IMAGE}")).toBeUndefined();
    expect(composeImage("acme/api:${TAG}")).toBe("acme/api");
    expect(composeImage("$REGISTRY/acme/api:$TAG")).toBe("acme/api");
    expect(composeImage("acme/${NAME}:1.0")).toBeUndefined();
    expect(composeImage("postgres:16")).toBe("postgres:16");
    expect(composeImage("${REGISTRY}/acme/postgres:16")).toBe("acme/postgres:16");
  });
});

// ─── k8s manifests → deployment model ───────────────────────────────────────

const sub = (id: string, name: string, root: string): SubProject =>
  ({ id, name, root, kind: "dotnet", markers: [] } as SubProject);

describe("renderHelmTemplate — named templates", () => {
  // What `helm create` writes, as written.
  const HELPERS = `{{/*
Expand the name of the chart.
*/}}
{{- define "shop.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "shop.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "shop.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "shop.selectorLabels" -}}
app.kubernetes.io/name: {{ include "shop.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "shop.labels" -}}
helm.sh/chart: {{ include "shop.chart" . }}
{{ include "shop.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
`;

  it("reads the defines of _helpers.tpl and renders includes through them, nindent and all", () => {
    const defines = chartDefines([HELPERS]);
    expect([...defines.keys()]).toEqual(["shop.name", "shop.fullname", "shop.chart", "shop.selectorLabels", "shop.labels"]);
    const chart = { name: "shop", version: "0.1.0", values: { nameOverride: "cars", fullnameOverride: "" } as any, defines };
    const out = renderHelmTemplate([
      "metadata:",
      '  name: {{ include "shop.fullname" . }}',
      "  labels:",
      '    {{- include "shop.labels" . | nindent 4 }}',
      "spec:",
      "  selector:",
      "    matchLabels:",
      '      {{- include "shop.selectorLabels" . | nindent 6 }}',
    ].join("\n"), chart);
    expect(out.split("\n").filter((l) => l.trim())).toEqual([
      "metadata:",
      // nameOverride set, the release name a stand-in for the chart's: printf "%s-%s" of the two.
      "  name: shop-cars",
      "  labels:",
      "    helm.sh/chart: shop-0.1.0",
      "    app.kubernetes.io/name: cars",
      "    app.kubernetes.io/instance: shop",
      "    app.kubernetes.io/managed-by: Helm",
      "spec:",
      "  selector:",
      "    matchLabels:",
      "      app.kubernetes.io/name: cars",
      "      app.kubernetes.io/instance: shop",
    ]);
    // An override is taken as written.
    const override = renderHelmTemplate('  name: {{ include "shop.fullname" . }}', { ...chart, values: { fullnameOverride: "cars-api" } as any });
    expect(override).toBe("  name: cars-api");
  });

  it("keeps an image built from a named template's inexact output empty", () => {
    const defines = chartDefines(['{{- define "shop.image" -}}{{ .Release.Name }}:1{{- end }}']);
    expect(renderHelmTemplate('image: {{ include "shop.image" . }}', { name: "shop", values: {} as any, defines })).toBe("image:");
    const exact = chartDefines(['{{- define "shop.image" -}}reg.io/shop:{{ .Chart.Version }}{{- end }}']);
    expect(renderHelmTemplate('image: {{ include "shop.image" . }}', { name: "shop", version: "2.0", values: {} as any, defines: exact })).toBe("image: reg.io/shop:2.0");
  });
});

describe("k8s deployment topology", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rdoc-k8s-"));
    await mkdir(join(root, "deploy"), { recursive: true });

    // Deployment + Service (different names — the Service is the DNS identity)
    // + ConfigMap env, all in one multi-doc manifest.
    await writeFile(
      join(root, "deploy", "player-api.yaml"),
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: player-api-deployment",
        "spec:",
        "  template:",
        "    metadata:",
        "      labels:",
        "        app: player-api",
        "    spec:",
        "      containers:",
        "        - name: api",
        "          image: reg.io/acme/player-api:2.0",
        "          envFrom:",
        "            - configMapRef:",
        "                name: player-api-config",
        "          env:",
        "            - name: ConnectionString",
        "              value: Host=pg;Database=players",
        "---",
        "apiVersion: v1",
        "kind: Service",
        "metadata:",
        "  name: player-svc",
        "spec:",
        "  selector:",
        "    app: player-api",
        "---",
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: player-api-config",
        "data:",
        "  LOG_LEVEL: debug",
      ].join("\n"),
    );

    // A second workload whose env URL points at the FIRST one's Service name.
    await writeFile(
      join(root, "deploy", "car-api.yaml"),
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: car-api",
        "spec:",
        "  template:",
        "    spec:",
        "      containers:",
        "        - name: api",
        "          image: reg.io/acme/car-api:1.1",
        "          env:",
        "            - name: PLAYERS_API_URL",
        "              value: http://player-svc:8080",
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
        "              value: players",
      ].join("\n"),
    );

    // Ingress routing to the first workload's Service + a secretKeyRef env.
    await writeFile(
      join(root, "deploy", "ingress.yaml"),
      [
        "apiVersion: networking.k8s.io/v1",
        "kind: Ingress",
        "metadata:",
        "  name: main-ingress",
        "spec:",
        "  rules:",
        "    - host: shop.example.com",
        "      http:",
        "        paths:",
        "          - path: /",
        "            backend:",
        "              service:",
        "                name: player-svc",
        "                port:",
        "                  number: 80",
        "---",
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: billing-api",
        "spec:",
        "  template:",
        "    spec:",
        "      containers:",
        "        - name: api",
        "          image: reg.io/acme/billing-api:1.0",
        "          env:",
        "            - name: ConnectionString",
        "              valueFrom:",
        "                secretKeyRef:",
        "                  name: billing-db",
        "                  key: connection-string",
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
    expect(k8s.files).toHaveLength(3);

    const all = k8s.groups.flat();
    const player = all.find((s) => s.name === "player-api-deployment")!;
    expect(player.image).toBe("reg.io/acme/player-api:2.0");
    expect(player.env.LOG_LEVEL).toBe("debug"); // envFrom configMapRef merged
    expect(player.env.ConnectionString).toBe("Host=pg;Database=players");

    expect(k8s.aliases.get("player-svc")).toBe("player-api-deployment");
  });

  it("synthesizes ${secret.key} placeholders for secretKeyRef env values", async () => {
    const k8s = (await collectK8sManifests(root))!;
    const billing = k8s.groups.flat().find((s) => s.name === "billing-api")!;
    expect(billing.env.ConnectionString).toBe("${billing-db.connection-string}");
  });

  it("feeds detectDeployment: app/datastore classification, URL edge via Service alias, db edge", async () => {
    const model = (await detectDeployment(root, {
      subProjects: [sub("p1", "PlayerApi", "player-api"), sub("p2", "CarApi", "car-api")],
    }))!;
    expect(model).toBeDefined();

    const names = model.services.map((s) => s.name).sort();
    expect(names).toEqual(["billing-api", "car-api", "main-ingress", "pg", "player-api-deployment"]);

    // The ingress classifies as proxy and routes to the workload the Service
    // alias selects, labelled with the rule host.
    expect(model.services.find((s) => s.name === "main-ingress")!.kind).toBe("proxy");
    expect(model.edges).toContainEqual(
      expect.objectContaining({
        from: "main-ingress",
        to: "player-api-deployment",
        kind: "http",
        label: "shop.example.com",
        via: "ingress",
      }),
    );

    // secretKeyRef-backed ConnectionString still yields a logical database
    // (name inferred from the secret's name: billing-db → billing).
    const billing = model.services.find((s) => s.name === "billing-api")!;
    expect(billing.databases?.map((d) => d.name)).toContain("billing");
    expect(model.services.find((s) => s.name === "pg")!.kind).toBe("datastore");
    expect(model.services.find((s) => s.name === "pg")!.hostedDatabases).toContain("players");

    // car-api → player-api via http://player-svc (Service alias resolution).
    expect(model.edges).toContainEqual(
      expect.objectContaining({ from: "car-api", to: "player-api-deployment", kind: "http" }),
    );
    // player-api → pg via its literal connection string naming Database=players.
    expect(model.edges).toContainEqual(
      expect.objectContaining({ from: "player-api-deployment", to: "pg", kind: "db", label: "players" }),
    );
  });
});
