import ts from "typescript";

export type WebSecurityViolation = {
  file: string;
  line: number;
  rule: "react-html" | "dom-html" | "document-write" | "eval" | "function-constructor";
  detail: string;
};

const unwrap = (expression: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression);

const member = (expression: ts.Expression): { object: ts.Expression; name: string } | null => {
  const unwrapped = unwrap(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) return { object: unwrap(unwrapped.expression), name: unwrapped.name.text };
  if (ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression && ts.isStringLiteral(unwrapped.argumentExpression)) {
    return { object: unwrap(unwrapped.expression), name: unwrapped.argumentExpression.text };
  }
  return null;
};

const isIdentifier = (expression: ts.Expression, name: string): boolean => {
  const unwrapped = unwrap(expression);
  return ts.isIdentifier(unwrapped) && unwrapped.text === name;
};

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

const isDocument = (expression: ts.Expression): boolean => {
  if (isIdentifier(expression, "document")) return true;
  const reference = member(expression);
  return reference?.name === "document" && (isIdentifier(reference.object, "window") || isIdentifier(reference.object, "globalThis"));
};

const literalPropertyName = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrap(name.expression);
    return ts.isStringLiteral(expression) ? expression.text : null;
  }
  return null;
};

const objectPropertyName = (property: ts.ObjectLiteralElementLike): string | null => {
  if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
    return literalPropertyName(property.name);
  }
  return null;
};

const isFunctionConstructor = (expression: ts.Expression): boolean => {
  if (isIdentifier(expression, "Function")) return true;
  const reference = member(expression);
  return reference?.name === "Function" && (isIdentifier(reference.object, "globalThis") || isIdentifier(reference.object, "window"));
};

export function checkWebSecuritySource(file: string, source: string): WebSecurityViolation[] {
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const violations: WebSecurityViolation[] = [];
  const report = (node: ts.Node, rule: WebSecurityViolation["rule"], detail: string) => {
    violations.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, rule, detail });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "dangerouslySetInnerHTML") {
      report(node, "react-html", "React dangerouslySetInnerHTML injects HTML into the DOM");
    }
    if (ts.isJsxSpreadAttribute(node)) {
      const spread = unwrap(node.expression);
      if (ts.isObjectLiteralExpression(spread) && spread.properties.some((property) => objectPropertyName(property) === "dangerouslySetInnerHTML")) {
        report(node, "react-html", "JSX spread passes dangerouslySetInnerHTML into the DOM");
      }
    }

    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      const target = member(node.left);
      if (target && (target.name === "innerHTML" || target.name === "outerHTML")) {
        report(node.left, "dom-html", `assignment to .${target.name} injects HTML into the DOM`);
      }
    }

    if (ts.isCallExpression(node)) {
      if (isIdentifier(node.expression, "eval")) report(node.expression, "eval", "direct eval() executes source text");
      const target = member(node.expression);
      if (target) {
        if (target.name === "insertAdjacentHTML") report(node.expression, "dom-html", "insertAdjacentHTML() injects HTML into the DOM");
        if (isDocument(target.object) && (target.name === "write" || target.name === "writeln")) {
          report(node.expression, "document-write", `document.${target.name}() writes HTML into the document`);
        }
        if (target.name === "eval" && (isIdentifier(target.object, "globalThis") || isIdentifier(target.object, "window"))) {
          report(node.expression, "eval", "global eval() executes source text");
        }
        if (target.name === "Function" && (isIdentifier(target.object, "globalThis") || isIdentifier(target.object, "window"))) {
          report(node.expression, "function-constructor", "global Function() executes source text");
        }
      }
    }

    if (ts.isNewExpression(node) && isFunctionConstructor(node.expression)) {
      report(node.expression, "function-constructor", "new Function() executes source text");
    }

    ts.forEachChild(node, visit);
  };

  visit(tree);
  return violations;
}
