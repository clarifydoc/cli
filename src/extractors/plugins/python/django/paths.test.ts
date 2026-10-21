import { describe, it, expect } from "vitest";
import { djangoRoute, joinDjango } from "./paths.js";

describe("djangoRoute", () => {
  it("turns path() converters into parameters", () => {
    expect(djangoRoute("documents/<int:pk>/notes/", false)).toBe("documents/{pk}/notes/");
    expect(djangoRoute("players/<slug>/", false)).toBe("players/{slug}/");
  });

  it("reduces a re_path regex to the path it matches", () => {
    expect(djangoRoute("^api/", true)).toBe("api/");
    expect(djangoRoute("^$", true)).toBe("");
    expect(djangoRoute("^documents/(?P<pk>[^/.]+)/$", true)).toBe("documents/{pk}/");
    expect(djangoRoute("versions/(?P<version_id>\\d+)", true)).toBe("versions/{version_id}");
    expect(djangoRoute("^share/(?P<slug>\\w+)/?$", true)).toBe("share/{slug}/");
  });

  it("drops an optional group and keeps an unnamed one as a parameter", () => {
    expect(djangoRoute("^items(\\.(?P<format>[a-z0-9]+))?/?$", true)).toBe("items/");
    expect(djangoRoute("^items/([0-9]+)/$", true)).toBe("items/{}/");
  });

  it("joins like Django: plain string concatenation, one leading slash", () => {
    expect(joinDjango("api/", "documents/", "bulk_edit/")).toBe("/api/documents/bulk_edit/");
    expect(joinDjango("", "")).toBe("/");
  });
});
