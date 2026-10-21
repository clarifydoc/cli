import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { detectGitopsReleases } from "./gitops-releases.js";
import type { SubProject } from "../types/analysis.js";

describe("GitOps releases", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-gitops-"));
    const put = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await put("deploy/flux/cars.yaml", `apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: shop
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: cars
  namespace: shop
spec:
  releaseName: cars-api
  chart:
    spec:
      chart: ./charts/cars
      sourceRef:
        kind: GitRepository
        name: shop
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: redis
spec:
  targetNamespace: data
  chart:
    spec:
      chart: redis
      version: 18.1.0
      sourceRef:
        kind: HelmRepository
        name: bitnami
`);
    await put("deploy/argo/apps.yaml", `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: web
spec:
  source:
    repoURL: https://github.com/acme/shop
    path: web/k8s
    targetRevision: main
  destination:
    namespace: web
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ingress
spec:
  source:
    repoURL: https://kubernetes.github.io/ingress-nginx
    chart: ingress-nginx
    targetRevision: 4.10.0
  destination:
    namespace: ingress
`);
    await put("deploy/kustomize/kustomization.yaml", `helmCharts:
  - name: cert-manager
    repo: https://charts.jetstack.io
    version: v1.14.0
    releaseName: certs
`);
    await put("infra/helm.tf", `resource "helm_release" "metrics" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = "3.12.0"
  namespace  = "kube-system"
  set {
    name  = "args"
    value = "{--kubelet-insecure-tls}"
  }
}
`);
    await put("README.yaml", "kind: Application\nname: not argo\n");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads Flux, Argo CD, kustomize and Terraform Helm releases as deploy rows, local charts with their sub-project", async () => {
    const projects = [{ id: "cars", root: "charts/cars" }, { id: "web", root: "web" }] as unknown as SubProject[];
    const rows = (await detectGitopsReleases(dir, projects)).map((r) => `${r.provider} ${r.kind} ${r.job} ${r.path ?? "-"} ${r.project ?? "-"} | ${r.via}`);
    expect(rows).toEqual([
      "argo kubernetes web web/k8s web | Application web: web/k8s at https://github.com/acme/shop main into web",
      "argo helm ingress - - | Application ingress: chart ingress-nginx 4.10.0 from https://kubernetes.github.io/ingress-nginx into ingress",
      "flux helm cars-api charts/cars cars | HelmRelease cars: chart ./charts/cars from GitRepository shop into shop",
      "flux helm redis - - | HelmRelease redis: chart redis 18.1.0 from HelmRepository bitnami into data",
      "kustomize helm certs - - | helmCharts cert-manager v1.14.0 from https://charts.jetstack.io",
      "terraform helm metrics-server - - | helm_release metrics: chart metrics-server 3.12.0 from https://kubernetes-sigs.github.io/metrics-server/ into kube-system",
    ]);
  });
});
