import { Parser } from "acorn";
import { generate } from "astring";

type Node = Record<string, unknown> & {
  type: string;
};

type ProgramNode = Node & {
  body: Node[];
};

type IdentifierNode = Node & {
  type: "Identifier";
  name: string;
};

type PatternNode = Node;

type FunctionLikeNode = Node & {
  id?: IdentifierNode | null;
};

export type CompiledRlmStep = {
  trackedNames: string[];
  declaredNames: string[];
  definitionNames: string[];
  definitionStatements: Array<{
    name: string;
    statement: string;
  }>;
  transformedCode: string;
};

const RESERVED_NAMES = new Set([
  "SUBMIT",
  "console",
  "corpus",
  "inputs",
  "print",
  "tools",
  "resources",
  "rlm",
]);

function identifier(name: string): IdentifierNode {
  return {
    type: "Identifier",
    name,
  };
}

function expressionStatement(expression: Node): Node {
  return {
    type: "ExpressionStatement",
    expression,
  };
}

function assignmentStatement(left: PatternNode, right: Node): Node {
  return expressionStatement({
    type: "AssignmentExpression",
    operator: "=",
    left,
    right,
  });
}

function undefinedNode(): IdentifierNode {
  return identifier("undefined");
}

function collectBindingNames(pattern: PatternNode, names: Set<string>): void {
  if (pattern.type === "Identifier") {
    const name = (pattern as IdentifierNode).name;
    if (RESERVED_NAMES.has(name)) {
      throw new Error(`RLM steps may not redeclare reserved helper "${name}".`);
    }
    names.add(name);
    return;
  }

  if (pattern.type === "ObjectPattern") {
    for (const property of ((pattern as { properties?: Node[] }).properties ?? [])) {
      if (property.type === "Property") {
        collectBindingNames((property as unknown as { value: PatternNode }).value, names);
      } else if (property.type === "RestElement") {
        collectBindingNames((property as unknown as { argument: PatternNode }).argument, names);
      }
    }
    return;
  }

  if (pattern.type === "ArrayPattern") {
    for (const element of ((pattern as { elements?: Array<PatternNode | null> }).elements ?? [])) {
      if (element != null) {
        collectBindingNames(element, names);
      }
    }
    return;
  }

  if (pattern.type === "AssignmentPattern") {
    collectBindingNames((pattern as unknown as { left: PatternNode }).left, names);
    return;
  }

  if (pattern.type === "RestElement") {
    collectBindingNames((pattern as unknown as { argument: PatternNode }).argument, names);
  }
}

function isFunctionLike(node: Node | null | undefined): node is FunctionLikeNode {
  return (
    node != null &&
    (node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionDeclaration" ||
      node.type === "ClassExpression" ||
      node.type === "ClassDeclaration")
  );
}

function cloneNode<T extends Node>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function varDeclarationFromDefinitionName(name: string, value: Node): Node {
  return {
    type: "VariableDeclaration",
    kind: "var",
    declarations: [
      {
        type: "VariableDeclarator",
        id: identifier(name),
        init: value,
      },
    ],
  };
}

function toDefinitionStatement(statement: Node): string {
  return generate(statement);
}

function rejectUnsupported(statement: Node): void {
  if (statement.type.startsWith("Import") || statement.type.startsWith("Export")) {
    throw new Error("RLM steps may not use import or export statements.");
  }
}

export function compileRlmStep(code: string, existingTrackedNames: string[]): CompiledRlmStep {
  const program = Parser.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
  }) as unknown as ProgramNode;

  const declaredNames = new Set<string>();
  const valueNames = new Set<string>();
  const definitionNames = new Set<string>();
  const definitionStatements = new Map<string, string>();
  const transformedBody: Node[] = [];

  for (const statement of program.body) {
    rejectUnsupported(statement);

    if (statement.type === "VariableDeclaration") {
      const declarations = (statement as unknown as { declarations: Array<{ id: PatternNode; init?: Node | null }> })
        .declarations;
      for (const declaration of declarations) {
        collectBindingNames(declaration.id, declaredNames);

        if (declaration.id.type === "Identifier" && isFunctionLike(declaration.init)) {
          const name = String(declaration.id.name);
          definitionNames.add(name);
          const definition = varDeclarationFromDefinitionName(name, cloneNode(declaration.init as Node));
          transformedBody.push(definition);
          definitionStatements.set(
            name,
            toDefinitionStatement(definition),
          );
          continue;
        }

        collectBindingNames(declaration.id, valueNames);
        transformedBody.push(
          assignmentStatement(
            cloneNode(declaration.id),
            cloneNode((declaration.init ?? undefinedNode()) as Node),
          ),
        );
      }
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      const declaration = statement as FunctionLikeNode;
      if (declaration.id == null) {
        throw new Error("RLM steps may not declare anonymous top-level functions.");
      }
      declaredNames.add(declaration.id.name);
      definitionNames.add(declaration.id.name);
      const expression = {
        ...cloneNode(statement),
        type: "FunctionExpression",
      };
      const definition = varDeclarationFromDefinitionName(declaration.id.name, expression);
      transformedBody.push(definition);
      definitionStatements.set(declaration.id.name, toDefinitionStatement(definition));
      continue;
    }

    if (statement.type === "ClassDeclaration") {
      const declaration = statement as FunctionLikeNode;
      if (declaration.id == null) {
        throw new Error("RLM steps may not declare anonymous top-level classes.");
      }
      declaredNames.add(declaration.id.name);
      definitionNames.add(declaration.id.name);
      const expression = {
        ...cloneNode(statement),
        type: "ClassExpression",
      };
      const definition = varDeclarationFromDefinitionName(declaration.id.name, expression);
      transformedBody.push(definition);
      definitionStatements.set(declaration.id.name, toDefinitionStatement(definition));
      continue;
    }

    transformedBody.push(cloneNode(statement));
  }

  const trackedNames = [...new Set([...existingTrackedNames, ...valueNames])].sort((left, right) =>
    left.localeCompare(right),
  );

  return {
    trackedNames,
    declaredNames: [...declaredNames].sort((left, right) => left.localeCompare(right)),
    definitionNames: [...definitionNames].sort((left, right) => left.localeCompare(right)),
    definitionStatements: [...definitionStatements.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, statement]) => ({
        name,
        statement,
      })),
    transformedCode: transformedBody.map((statement) => generate(statement)).join("\n"),
  };
}
