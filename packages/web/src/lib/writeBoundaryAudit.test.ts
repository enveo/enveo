import { describe, expect, it } from "bun:test";
import ts from "typescript";

type Boundary = "account-storage" | "server-write";

interface Finding {
  boundary: Boundary;
  callee: string;
  file: string;
  line: number;
  method: string;
  owner: string;
  target: string;
  wrapped: boolean;
}

const SERVER_WRAPPERS = new Set(["runServerWriteOperation", "runCoordinatedSessionEnd"]);
const STORAGE_WRAPPERS = new Set(["runAccountStorageWrite", "runPersistenceAccountStorageWrite"]);
const IDB_OBJECT_STORE_MUTATORS = new Set(["add", "clear", "delete", "put"]);
const IDB_SCHEMA_MUTATORS = new Set(["createObjectStore", "deleteObjectStore"]);
const BACKEND_MUTATORS = new Set([
  "add",
  "clear",
  "clearAll",
  "delete",
  "deleteExpiredImportDrafts",
  "deleteImportDraftIfMatches",
  "deleteImportJobIfScope",
  "deleteImportJobWithMetaIfScope",
  "moveToDeadLetter",
  "mutateImportDraftState",
  "mutateMeta",
  "put",
  "putImportDraftIfAbsentOrSame",
  "putImportJobForScope",
  "putImportJobIfRevision",
  "putMany",
]);

/**
 * Calls below are the implementation core behind the public registries, not alternate entry
 * points. Keeping every site as a full AST-derived identity makes a second call in the same file
 * visible instead of inheriting a file-wide exemption.
 */
const AUDITED_UNWRAPPED_WRITE_SITES = [
  "account-storage|lib/idb.ts|add|db.transaction|READWRITE|<dynamic>",
  "account-storage|lib/idb.ts|add|this.fallback.add|add|<dynamic>",
  "account-storage|lib/idb.ts|add|tx.objectStore().add|add|<dynamic>",
  "account-storage|lib/idb.ts|clear|db.transaction|READWRITE|<dynamic>",
  "account-storage|lib/idb.ts|clear|this.fallback.clear|clear|<dynamic>",
  "account-storage|lib/idb.ts|clear|tx.objectStore().clear|clear|<missing>",
  "account-storage|lib/idb.ts|clearAll|db.transaction|READWRITE|<dynamic>",
  "account-storage|lib/idb.ts|clearAll|this.fallback.clearAll|clearAll|<missing>",
  "account-storage|lib/idb.ts|clearAll|tx.objectStore().clear|clear|<missing>",
  "account-storage|lib/idb.ts|clearAll|tx.objectStore().clear|clear|<missing>",
  "account-storage|lib/idb.ts|clearAll|tx.objectStore().clear|clear|<missing>",
  "account-storage|lib/idb.ts|clearAll|tx.objectStore().clear|clear|<missing>",
  "account-storage|lib/idb.ts|clearAll|tx.objectStore().clear|clear|<missing>",
  "account-storage|lib/idb.ts|delete|db.transaction|READWRITE|<dynamic>",
  "account-storage|lib/idb.ts|delete|this.fallback.delete|delete|<dynamic>",
  "account-storage|lib/idb.ts|delete|tx.objectStore().delete|delete|<dynamic>",
  "account-storage|lib/idb.ts|deleteDb|indexedDB.deleteDatabase|deleteDatabase|<dynamic>",
  "account-storage|lib/idb.ts|deleteExpiredImportDrafts|db.transaction|READWRITE|importDrafts",
  "account-storage|lib/idb.ts|deleteExpiredImportDrafts|this.fallback.deleteExpiredImportDrafts|deleteExpiredImportDrafts|<dynamic>",
  "account-storage|lib/idb.ts|deleteExpiredImportDrafts|tx.objectStore().delete|delete|<dynamic>",
  "account-storage|lib/idb.ts|deleteImportDraftIfMatches|db.transaction|READWRITE|importDrafts",
  "account-storage|lib/idb.ts|deleteImportDraftIfMatches|this.fallback.deleteImportDraftIfMatches|deleteImportDraftIfMatches|<dynamic>",
  "account-storage|lib/idb.ts|deleteImportDraftIfMatches|tx.objectStore().delete|delete|<dynamic>",
  "account-storage|lib/idb.ts|deleteImportJobIfScope|db.transaction|READWRITE|importJobs",
  "account-storage|lib/idb.ts|deleteImportJobIfScope|this.fallback.deleteImportJobIfScope|deleteImportJobIfScope|<dynamic>",
  "account-storage|lib/idb.ts|deleteImportJobIfScope|tx.objectStore().delete|delete|<dynamic>",
  "account-storage|lib/idb.ts|deleteImportJobWithMetaIfScope|db.transaction|READWRITE|<dynamic>",
  "account-storage|lib/idb.ts|deleteImportJobWithMetaIfScope|this.fallback.deleteImportJobWithMetaIfScope|deleteImportJobWithMetaIfScope|<dynamic>",
  "account-storage|lib/idb.ts|deleteImportJobWithMetaIfScope|tx.objectStore().delete|delete|<dynamic>",
  "account-storage|lib/idb.ts|deleteImportJobWithMetaIfScope|tx.objectStore().delete|delete|<dynamic>",
  "account-storage|lib/idb.ts|deleteLegacyDb|indexedDB.deleteDatabase|deleteDatabase|<dynamic>",
  "account-storage|lib/idb.ts|moveToDeadLetter|db.transaction|READWRITE|<dynamic>",
  "account-storage|lib/idb.ts|moveToDeadLetter|this.fallback.moveToDeadLetter|moveToDeadLetter|<dynamic>",
  "account-storage|lib/idb.ts|moveToDeadLetter|tx.objectStore().delete|delete|<dynamic>",
  "account-storage|lib/idb.ts|moveToDeadLetter|tx.objectStore().put|put|<dynamic>",
  "account-storage|lib/idb.ts|mutateImportDraftState|db.transaction|READWRITE|importDrafts",
  "account-storage|lib/idb.ts|mutateImportDraftState|this.fallback.mutateImportDraftState|mutateImportDraftState|<dynamic>",
  "account-storage|lib/idb.ts|mutateImportDraftState|tx.objectStore().put|put|<dynamic>",
  "account-storage|lib/idb.ts|mutateMeta|db.transaction|READWRITE|meta",
  "account-storage|lib/idb.ts|mutateMeta|this.fallback.mutateMeta|mutateMeta|<dynamic>",
  "account-storage|lib/idb.ts|mutateMeta|tx.objectStore().put|put|<dynamic>",
  "account-storage|lib/idb.ts|openRaw|db.createObjectStore|createObjectStore|deadletter",
  "account-storage|lib/idb.ts|openRaw|db.createObjectStore|createObjectStore|importDrafts",
  "account-storage|lib/idb.ts|openRaw|db.createObjectStore|createObjectStore|importJobs",
  "account-storage|lib/idb.ts|openRaw|db.createObjectStore|createObjectStore|meta",
  "account-storage|lib/idb.ts|openRaw|db.createObjectStore|createObjectStore|outbox",
  "account-storage|lib/idb.ts|openRaw|indexedDB.open|open|<dynamic>",
  "account-storage|lib/idb.ts|put|db.transaction|READWRITE|<dynamic>",
  "account-storage|lib/idb.ts|put|this.fallback.put|put|<dynamic>",
  "account-storage|lib/idb.ts|put|tx.objectStore().put|put|<dynamic>",
  "account-storage|lib/idb.ts|putImportDraftIfAbsentOrSame|db.transaction|READWRITE|importDrafts",
  "account-storage|lib/idb.ts|putImportDraftIfAbsentOrSame|this.fallback.putImportDraftIfAbsentOrSame|putImportDraftIfAbsentOrSame|<dynamic>",
  "account-storage|lib/idb.ts|putImportDraftIfAbsentOrSame|tx.objectStore().put|put|<dynamic>",
  "account-storage|lib/idb.ts|putImportJobForScope|db.transaction|READWRITE|importJobs",
  "account-storage|lib/idb.ts|putImportJobForScope|this.fallback.putImportJobForScope|putImportJobForScope|<dynamic>",
  "account-storage|lib/idb.ts|putImportJobForScope|tx.objectStore().put|put|<dynamic>",
  "account-storage|lib/idb.ts|putImportJobIfRevision|db.transaction|READWRITE|importJobs",
  "account-storage|lib/idb.ts|putImportJobIfRevision|this.fallback.putImportJobIfRevision|putImportJobIfRevision|<dynamic>",
  "account-storage|lib/idb.ts|putImportJobIfRevision|tx.objectStore().put|put|<dynamic>",
  "account-storage|lib/idb.ts|putMany|db.transaction|READWRITE|<dynamic>",
  "account-storage|lib/idb.ts|putMany|this.fallback.putMany|putMany|<dynamic>",
  "account-storage|lib/idb.ts|putMany|tx.objectStore().put|put|<dynamic>",
  "server-write|lib/accountPreferencesRemote.ts|request|fetch|DYNAMIC|/api/preferences/account",
  "server-write|lib/api.ts|httpImpl|fetch|DYNAMIC|/api",
  "server-write|lib/openai.ts|postChatImpl|fetch|POST|<dynamic>",
  "server-write|lib/sync/transport.ts|pushE2eeBatchImpl|fetch|POST|/api/sync2/push",
  "server-write|lib/sync/transport.ts|pushPlainBatchImpl|fetch|POST|/api/sync/push",
  "server-write|lib/sync/transport.ts|replaceServer|fetch|POST|/api/sync/replace",
  "server-write|lib/sync/transport.ts|resetServerE2eeImpl|fetch|POST|/api/sync2/reset",
  "server-write|lib/sync/upgrade.ts|upgradeServerE2eeV2Impl|fetch|POST|/api/budget/e2ee/upgrade-v2",
] as const;

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return null;
}

function directTypeName(type: ts.TypeNode): string | null {
  if (ts.isParenthesizedTypeNode(type)) return directTypeName(type.type);
  if (!ts.isTypeReferenceNode(type)) return null;
  if (ts.isIdentifier(type.typeName)) return type.typeName.text;
  return type.typeName.right.text;
}

function expressionPath(expression: ts.Expression, aliases: ReadonlyMap<string, string>): string {
  if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? expression.text;
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if ((ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) && directTypeName(expression.type) === "IDBObjectStore") {
    return "IDBObjectStore";
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
    return expressionPath(expression.expression, aliases);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const path = `${expressionPath(expression.expression, aliases)}.${expression.name.text}`;
    return aliases.get(path) ?? path;
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)) {
    const path = `${expressionPath(expression.expression, aliases)}.${expression.argumentExpression.text}`;
    return aliases.get(path) ?? path;
  }
  if (ts.isCallExpression(expression)) return `${expressionPath(expression.expression, aliases)}()`;
  return "<dynamic>";
}

function containingFunction(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      if (current.name && ts.isIdentifier(current.name)) return current.name.text;
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
      if (ts.isPropertyAssignment(current.parent)) return propertyName(current.parent.name) ?? "<anonymous>";
    }
  }
  return "<module>";
}

function isInsideWrapper(node: ts.Node, aliases: ReadonlyMap<string, string>, wrappers: ReadonlySet<string>): boolean {
  let functionDepth = 0;
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current))
      functionDepth++;
    if (!ts.isCallExpression(current)) continue;
    const path = expressionPath(current.expression, aliases);
    const name = path.split(".").at(-1) ?? path;
    if (!wrappers.has(name)) continue;
    if (current.arguments.some((argument) => node.getStart() >= argument.getStart() && node.end <= argument.end)) return functionDepth <= 1;
  }
  return false;
}

function optionsMethod(options: ts.Expression | undefined, fallback = "GET"): string {
  if (!options) return fallback;
  if (!ts.isObjectLiteralExpression(options)) return "DYNAMIC";
  for (const property of options.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === "method") return "DYNAMIC";
    if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== "method") continue;
    return ts.isStringLiteralLike(property.initializer) ? property.initializer.text.toUpperCase() : "DYNAMIC";
  }
  return options.properties.some(ts.isSpreadAssignment) ? "DYNAMIC" : fallback;
}

function constructedRequest(call: ts.CallExpression): ts.NewExpression | null {
  const target = call.arguments[0];
  if (!target || !ts.isNewExpression(target)) return null;
  const path = expressionPath(target.expression, new Map());
  return path === "Request" || path.endsWith(".Request") ? target : null;
}

function fetchMethod(call: ts.CallExpression): string {
  const request = constructedRequest(call);
  const input = request?.arguments?.[0] ?? call.arguments[0];
  const inherited = input && (ts.isStringLiteralLike(input) || ts.isTemplateExpression(input)) ? "GET" : "DYNAMIC";
  const requestMethod = request ? optionsMethod(request.arguments?.[1], inherited) : inherited;
  return optionsMethod(call.arguments[1], requestMethod);
}

function callTarget(call: ts.CallExpression): string {
  const target = constructedRequest(call)?.arguments?.[0] ?? call.arguments[0];
  if (!target) return "<missing>";
  if (ts.isStringLiteralLike(target) || ts.isNoSubstitutionTemplateLiteral(target)) return target.text;
  if (ts.isTemplateExpression(target)) return target.head.text || "<template>";
  return "<dynamic>";
}

function isAuthWrite(path: string): boolean {
  return path === "authClient.signOut" || path.startsWith("authClient.signIn.") || path.startsWith("authClient.signUp.");
}

function isIdbObjectStoreType(type: ts.TypeNode | undefined, typeAliases: ReadonlySet<string> = new Set()): boolean {
  if (!type) return false;
  if (ts.isParenthesizedTypeNode(type)) return isIdbObjectStoreType(type.type, typeAliases);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return type.types.some((member) => isIdbObjectStoreType(member, typeAliases));
  const name = directTypeName(type);
  return name === "IDBObjectStore" || (name !== null && typeAliases.has(name));
}

function assertedIdbObjectStore(expression: ts.Expression | undefined, typeAliases: ReadonlySet<string>): boolean {
  if (!expression) return false;
  if (ts.isParenthesizedExpression(expression)) return assertedIdbObjectStore(expression.expression, typeAliases);
  return (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) && isIdbObjectStoreType(expression.type, typeAliases);
}

function auditSource(file: string, source: string): Finding[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) throw new Error(`write_boundary_parse_failed:${file}`);
  const aliases = new Map<string, string>();
  const idbTypeAliases = new Set<string>();
  const findings: Finding[] = [];

  const typeAliasDeclarations: ts.TypeAliasDeclaration[] = [];
  const collectTypeAliases = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node)) typeAliasDeclarations.push(node);
    ts.forEachChild(node, collectTypeAliases);
  };
  collectTypeAliases(parsed);
  for (let changed = true; changed; ) {
    changed = false;
    for (const declaration of typeAliasDeclarations) {
      if (idbTypeAliases.has(declaration.name.text) || !isIdbObjectStoreType(declaration.type, idbTypeAliases)) continue;
      idbTypeAliases.add(declaration.name.text);
      changed = true;
    }
  }

  const record = (node: ts.CallExpression, boundary: Boundary, callee: string, method: string, target: string, wrapped: boolean) => {
    const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    findings.push({ boundary, callee, file, line: position.line + 1, method, owner: containingFunction(node), target, wrapped });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && isIdbObjectStoreType(node.type, idbTypeAliases)) {
      aliases.set(node.name.text, "IDBObjectStore");
      if (ts.isConstructorDeclaration(node.parent) && node.modifiers?.length) aliases.set(`this.${node.name.text}`, "IDBObjectStore");
    }
    if (ts.isPropertyDeclaration(node) && isIdbObjectStoreType(node.type, idbTypeAliases)) {
      const name = propertyName(node.name);
      if (name) aliases.set(`this.${name}`, "IDBObjectStore");
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const path = node.initializer ? expressionPath(node.initializer, aliases) : "<missing>";
      const boundMutator = path.match(/^IDBObjectStore\.(add|clear|delete|put)\.bind\(\)$/)?.[1];
      if (isIdbObjectStoreType(node.type, idbTypeAliases) || assertedIdbObjectStore(node.initializer, idbTypeAliases)) {
        aliases.set(node.name.text, "IDBObjectStore");
      } else if (boundMutator) {
        aliases.set(node.name.text, `IDBObjectStore.${boundMutator}`);
      } else if (
        node.initializer &&
        (path === "fetch" ||
          path.endsWith(".fetch") ||
          path === "indexedDB" ||
          path.endsWith(".indexedDB") ||
          path === "activeBackend()" ||
          path === "IDBObjectStore" ||
          /^IDBObjectStore\.(add|clear|delete|put)$/.test(path) ||
          path.endsWith(".objectStore()") ||
          path === "authClient" ||
          path.startsWith("authClient."))
      ) {
        aliases.set(node.name.text, path);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const receiver = expressionPath(node.initializer, aliases);
      if (receiver === "IDBObjectStore") {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const member = element.propertyName ? propertyName(element.propertyName) : element.name.text;
          if (member && IDB_OBJECT_STORE_MUTATORS.has(member)) aliases.set(element.name.text, `IDBObjectStore.${member}`);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const path = expressionPath(node.expression, aliases);
      const method = path.split(".").at(-1) ?? path;
      if (path === "fetch" || path.endsWith(".fetch")) {
        const verb = fetchMethod(node);
        if (verb !== "GET" && verb !== "HEAD") record(node, "server-write", path, verb, callTarget(node), isInsideWrapper(node, aliases, SERVER_WRAPPERS));
      } else if (isAuthWrite(path)) {
        record(node, "server-write", path, "AUTH", "session", isInsideWrapper(node, aliases, SERVER_WRAPPERS));
      }

      const calledIdbMutator = path.match(/^IDBObjectStore\.(add|clear|delete|put)\.(?:call|apply)$/)?.[1];
      const backendMethod = calledIdbMutator ?? method.replace(/\(\)$/, "");
      const rawBackend =
        BACKEND_MUTATORS.has(backendMethod) &&
        (path.startsWith("activeBackend().") ||
          path.startsWith("this.fallback.") ||
          [...aliases.values()].some((alias) => path.startsWith(`${alias}.`) && alias === "activeBackend()"));
      const rawFactory =
        path === "indexedDB.open" || path === "indexedDB.deleteDatabase" || path.endsWith(".indexedDB.open") || path.endsWith(".indexedDB.deleteDatabase");
      const rawObjectStore = IDB_OBJECT_STORE_MUTATORS.has(backendMethod) && (path.includes(".objectStore().") || path.startsWith("IDBObjectStore."));
      const rawSchemaMutation = IDB_SCHEMA_MUTATORS.has(backendMethod);
      const transactionMode = backendMethod === "transaction" ? node.arguments[1] : undefined;
      const rawWriteTransaction =
        backendMethod === "transaction" && (transactionMode === undefined || !ts.isStringLiteralLike(transactionMode) || transactionMode.text === "readwrite");
      if (rawBackend || rawFactory || rawObjectStore || rawSchemaMutation || rawWriteTransaction) {
        record(
          node,
          "account-storage",
          path,
          rawWriteTransaction ? "READWRITE" : backendMethod,
          callTarget(node),
          isInsideWrapper(node, aliases, STORAGE_WRAPPERS),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return findings;
}

function findingKey(finding: Finding): string {
  return [finding.boundary, finding.file, finding.owner, finding.callee, finding.method, finding.target].join("|");
}

async function productionFindings(root = new URL("..", import.meta.url).pathname): Promise<Finding[]> {
  const paths = new Set<string>();
  try {
    for (const pattern of ["**/*.ts", "**/*.tsx"]) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
        if (path.includes(".test.")) continue;
        paths.add(path);
      }
    }
  } catch {
    throw new Error("write_boundary_discovery_failed:scan");
  }
  for (const required of ["lib/idb.ts", "lib/serverWriteOperations.ts", "lib/sync/multitab.ts"]) {
    if (!paths.has(required)) throw new Error(`write_boundary_discovery_failed:${required}`);
  }
  const findings: Finding[] = [];
  for (const path of [...paths].sort()) {
    const source = await Bun.file(`${root}/${path}`).text();
    findings.push(...auditSource(path, source));
  }
  return findings.sort((a, b) => findingKey(a).localeCompare(findingKey(b)) || a.line - b.line);
}

describe("write-boundary AST audit", () => {
  it("finds every individual aliased/computed server and account-storage write", () => {
    const findings = auditSource(
      "fixture.tsx",
      `
        const send = globalThis["fetch"];
        send("/one", { ["method"]: "POST" });
        send("/two", { method: verb });
        const terminate = authClient["signOut"];
        terminate();
        const sessionClient = authClient;
        sessionClient["signIn"]["email"]();
        const storage = activeBackend();
        storage["put"]("meta", value);
        connection.transaction("meta", "readwrite");
        const objectStore = connection["transaction"]("meta", "readwrite")["objectStore"]("meta");
        objectStore["delete"]("key");
        connection.transaction("meta", "readwrite").objectStore("meta").put(value, "key");
        database["createObjectStore"]("new-store");
      `,
    );

    expect(findings.map((finding) => [finding.boundary, finding.method, finding.target])).toEqual([
      ["server-write", "POST", "/one"],
      ["server-write", "DYNAMIC", "/two"],
      ["server-write", "AUTH", "session"],
      ["server-write", "AUTH", "session"],
      ["account-storage", "put", "meta"],
      ["account-storage", "READWRITE", "meta"],
      ["account-storage", "READWRITE", "meta"],
      ["account-storage", "delete", "key"],
      ["account-storage", "put", "<dynamic>"],
      ["account-storage", "READWRITE", "meta"],
      ["account-storage", "createObjectStore", "new-store"],
    ]);
    expect(findings.every((finding) => finding.wrapped === false)).toBe(true);
  });

  it("recognizes the exact structural wrappers despite computed formatting", () => {
    const findings = auditSource(
      "fixture.ts",
      `
        runServerWriteOperation("kind", () => globalThis["fetch"]("/write", { ["method"]: "DELETE" }));
        runAccountStorageWrite(() => activeBackend()["clear"]("meta"));
      `,
    );

    expect(findings.map((finding) => finding.wrapped)).toEqual([true, true]);
  });

  it("flags a write carried by a constructed Request", () => {
    const findings = auditSource(
      "request.ts",
      `
        fetch(new Request("/write", { method: "POST" }));
        fetch(new Request(existingRequest));
        fetch(new Request("/read"));
        fetch(requestVariable);
        const inheritedRequest = new Request(existingRequest);
        fetch(inheritedRequest);
        fetch(requestVariable, { credentials: "include" });
        fetch(new Request(existingRequest), { headers: { accept: "application/json" } });
        fetch(requestVariable, { method: "GET", credentials: "include" });
        fetch(new Request(existingRequest), { method: "HEAD" });
      `,
    );

    expect(findings.map((finding) => [finding.boundary, finding.method, finding.target, finding.wrapped])).toEqual([
      ["server-write", "POST", "/write", false],
      ["server-write", "DYNAMIC", "<dynamic>", false],
      ["server-write", "DYNAMIC", "<dynamic>", false],
      ["server-write", "DYNAMIC", "<dynamic>", false],
      ["server-write", "DYNAMIC", "<dynamic>", false],
      ["server-write", "DYNAMIC", "<dynamic>", false],
    ]);
  });

  it("flags mutations through declared IDBObjectStore receivers and aliases", () => {
    const findings = auditSource(
      "typed-store.ts",
      `
        function write(store: IDBObjectStore) {
          const alias = store;
          alias["put"](value, "key");
        }
        const asserted = unknownStore as IDBObjectStore;
        asserted.delete("key");
        declare const declared: IDBObjectStore;
        declared.add(value);
      `,
    );

    expect(findings.map((finding) => [finding.boundary, finding.method, finding.wrapped])).toEqual([
      ["account-storage", "put", false],
      ["account-storage", "delete", false],
      ["account-storage", "add", false],
    ]);
  });

  it("follows IDBObjectStore type aliases, receiver fields, and extracted mutator aliases", () => {
    const findings = auditSource(
      "aliased-store.ts",
      `
        function write(store: Store) {
          const receiver = store;
          receiver.put(value);
          const add = receiver.add;
          add(value);
          const remove = receiver.delete.bind(receiver);
          remove("key");
        }
        class Writer {
          constructor(private readonly store: Store) {}
          clear() {
            this.store.clear();
          }
        }
        type Store = IDBObjectStore;
      `,
    );

    expect(findings.map((finding) => [finding.boundary, finding.method, finding.wrapped])).toEqual([
      ["account-storage", "put", false],
      ["account-storage", "add", false],
      ["account-storage", "delete", false],
      ["account-storage", "clear", false],
    ]);
  });

  it("flags destructured and re-aliased IDBObjectStore mutators invoked with call", () => {
    const findings = auditSource(
      "destructured-store.ts",
      `
        function write(store: IDBObjectStore) {
          const { put } = store;
          put.call(store, value, "key");
          const { delete: remove } = store;
          const removeAlias = remove;
          removeAlias.call(store, "key");
        }
      `,
    );

    expect(findings.map((finding) => [finding.boundary, finding.method, finding.wrapped])).toEqual([
      ["account-storage", "put", false],
      ["account-storage", "delete", false],
    ]);
  });

  it("does not treat writes escaping through deferred nested callbacks as enrolled", () => {
    const findings = auditSource(
      "deferred.ts",
      `
        runServerWriteOperation("deferred", async () => {
          setTimeout(() => fetch("/late", { method: "POST" }), 0);
        });
        runAccountStorageWrite(async () => {
          queueMicrotask(() => activeBackend().put("meta", value));
          Promise.resolve().then(() => (typedStore as IDBObjectStore).clear());
        });
      `,
    );

    expect(findings.map((finding) => finding.wrapped)).toEqual([false, false, false]);
  });

  it("fails closed on syntax it cannot parse", () => {
    expect(() => auditSource("broken.ts", "const = ;")).toThrow("write_boundary_parse_failed:broken.ts");
  });

  it("fails closed when production source discovery is incomplete", async () => {
    await expect(productionFindings("/path/that/does/not/exist")).rejects.toThrow("write_boundary_discovery_failed");
  });

  it("covers every production TS/TSX write call with a wrapper or exact audited site", async () => {
    const findings = await productionFindings();
    const unwrapped = findings.filter((finding) => !finding.wrapped).map(findingKey);

    expect(unwrapped).toEqual([...AUDITED_UNWRAPPED_WRITE_SITES]);
  });
});
