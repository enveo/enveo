import ts from "typescript";

export type WebSecurityViolation = {
  file: string;
  line: number;
  rule: "react-html" | "dom-html" | "document-write" | "eval" | "function-constructor";
  detail: string;
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

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const name = node.left.name.text;
      if (name === "innerHTML" || name === "outerHTML") report(node.left, "dom-html", `assignment to .${name} injects HTML into the DOM`);
    }

    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "eval") report(node.expression, "eval", "direct eval() executes source text");
      if (ts.isPropertyAccessExpression(node.expression)) {
        const { expression, name } = node.expression;
        if (name.text === "insertAdjacentHTML") report(name, "dom-html", "insertAdjacentHTML() injects HTML into the DOM");
        if (ts.isIdentifier(expression) && expression.text === "document" && (name.text === "write" || name.text === "writeln")) {
          report(name, "document-write", `document.${name.text}() writes HTML into the document`);
        }
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      report(node.expression, "function-constructor", "new Function() executes source text");
    }

    ts.forEachChild(node, visit);
  };

  visit(tree);
  return violations;
}
