import type { Node, Tree } from "web-tree-sitter";
import type { TypeReference } from "../../../types/analysis.js";

/** Scopes that name no class of their own: `self::`, `static::` and `parent::` are the enclosing type's. */
const RELATIVE_SCOPES: ReadonlySet<string> = new Set(["self", "static", "parent"]);

/**
 * Uses of a class's constants (`Rules::GOAL`) and enum cases (`Status::Active`), where PHP writes them: in a method
 * body, a property default (`private array $rules = [Rules::GOAL => 3]`), a class constant or a parameter default.
 * The class named is read as a type: the class that declares the constant is a dependency of the code that names it,
 * so it shows in the type graph and in the blast radius of a change to that class. `Rules::class` names the class
 * itself and a `Rules::build()` call is a call (the call extractor's); both keep their own facts.
 */
export function extractPhpTypeReferences(tree: Tree, filePath: string): TypeReference[] {
  const out: TypeReference[] = [];
  if (!tree?.rootNode) return out;
  walk(tree.rootNode, filePath, "(top-level)", undefined, out);
  return out;
}

function walk(node: Node, filePath: string, symbol: string, cls: string | undefined, out: TypeReference[]): void {
  let here = symbol;
  let hereClass = cls;
  switch (node.type) {
    case "class_declaration":
    case "interface_declaration":
    case "trait_declaration":
    case "enum_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        here = name;
        hereClass = name;
      }
      break;
    }
    case "method_declaration":
    case "function_definition": {
      const name = node.childForFieldName("name")?.text;
      if (name) here = cls && node.type === "method_declaration" ? `${cls}.${name}` : name;
      break;
    }
    // A property default or a constant's value belongs to that member: `Scoring.rules`.
    case "property_element": {
      const name = node.namedChildren.find((c) => c.type === "variable_name")?.text.replace(/^\$/, "");
      if (name && cls) here = `${cls}.${name}`;
      break;
    }
    case "const_element": {
      const name = node.namedChildren.find((c) => c.type === "name")?.text;
      if (name && cls) here = `${cls}.${name}`;
      break;
    }
    case "class_constant_access_expression": {
      const scope = node.namedChildren[0];
      const member = node.namedChildren[1];
      if (scope && member && (scope.type === "name" || scope.type === "qualified_name") && member.text !== "class") {
        const typeName = scope.text.split("\\").pop()!;
        if (!RELATIVE_SCOPES.has(typeName.toLowerCase())) {
          const ref: TypeReference = {
            rawType: scope.text,
            typeName,
            usageKind: "constant",
            sourceFile: filePath,
            sourceLine: scope.startPosition.row + 1,
            sourceSymbol: symbol,
            confidence: "EXTRACTED",
          };
          if (cls) ref.sourceClass = cls;
          out.push(ref);
        }
      }
      break;
    }
  }
  for (const child of node.namedChildren) walk(child, filePath, here, hereClass, out);
}
