import { describe, it, expect } from "vitest";
import { javaKotlinReachability } from "./reachability.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const analysis = (filePath: string, cls: Record<string, unknown>): FileAnalysis =>
  ({ filePath, classes: [{ extends: null, implements: [], decorators: [], methods: [], ...cls }], functions: [], routes: [] }) as unknown as FileAnalysis;
const none = new Set<string>();

describe("Java/Kotlin reachability — what a container or a code generator loads", () => {
  it("keeps servlet initializers and Glide modules alive", async () => {
    const m = await javaKotlinReachability.load({ projectRoot: "/nonexistent", roots: [], files: new Set<string>() });
    const passive = (a: FileAnalysis) => m.passiveReason!(a, a.filePath, none);
    expect(passive(analysis("WebInit.java", { name: "WebInit", implements: ["WebApplicationInitializer"] }))).toMatch(/WebApplicationInitializer/);
    expect(passive(analysis("Dispatcher.java", { name: "Dispatcher", extends: "AbstractAnnotationConfigDispatcherServletInitializer" }))).toMatch(/Initializer/);
    expect(passive(analysis("MyGlide.java", { name: "MyGlide", extends: "AppGlideModule", decorators: ["GlideModule"] }))).not.toBeNull();
    expect(passive(analysis("Orphan.java", { name: "Orphan" }))).toBeNull();
  });
});

describe("Java/Kotlin reachability — the author's own word", () => {
  it("keeps a declaration suppressed as unused alive", async () => {
    const m = await javaKotlinReachability.load({ projectRoot: "/nonexistent", roots: [], files: new Set<string>() });
    expect(m.passiveReason!(analysis("K.kt", { name: "K", decorators: ['Suppress("unused")'] }), "K.kt", none)).not.toBeNull();
    expect(m.passiveReason!(analysis("J.java", { name: "J", decorators: ['SuppressWarnings({"unused", "rawtypes"})'] }), "J.java", none)).not.toBeNull();
    expect(m.passiveReason!(analysis("U.java", { name: "U", decorators: ['SuppressWarnings("unchecked")'] }), "U.java", none)).toBeNull();
  });
});
