import type { Tree } from "web-tree-sitter";

/**
 * The package a Java (`package_declaration`) or Kotlin (`package_header`) file declares —
 * `package com.example.league;` → `com.example.league`. It is what an `import` names, whatever
 * directory the file sits in; null for the default package.
 */
export function jvmPackageName(tree: Tree): string | null {
  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== "package_declaration" && node.type !== "package_header") continue;
    const name = node.text
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
      .replace(/^\s*package\b/, "")
      .replace(/[;`\s]/g, "");
    return /^[\w$.]+$/.test(name) ? name : null;
  }
  return null;
}
