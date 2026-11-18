import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

const ROOT = process.cwd();
const SCANNED = ["app", "components", "hooks", "lib", "server", "stores"];
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

type Binding = { local: string; imported: string; from: string };
type Module = { file: string; imports: Binding[]; edges: Set<string>; hoisted: Set<string>; loadReads: Set<string> };

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

function resolveSpecifier(from: string, specifier: string) {
  const base = specifier.startsWith("@/") ? join(ROOT, specifier.slice(2)) : specifier.startsWith(".") ? resolve(from, "..", specifier) : null;
  if (!base) return null;
  if (/\.tsx?$/.test(base) && existsSync(base)) return base;
  for (const extension of EXTENSIONS) if (existsSync(base + extension)) return base + extension;
  return null;
}

function typeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration) {
  if (ts.isImportDeclaration(node)) return Boolean(node.importClause?.isTypeOnly);
  return node.isTypeOnly;
}

function insideDeferredCode(node: ts.Node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent) && !ts.isClassStaticBlockDeclaration(parent)) return true;
    if (ts.isPropertyDeclaration(parent) && !parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) return true;
    if (ts.isTypeNode(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) return true;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExportSpecifier(parent)) return true;
  }
  return false;
}

function isValueReference(node: ts.Identifier) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return false;
  if (ts.isQualifiedName(parent)) return false;
  if (ts.isJsxAttribute(parent)) return false;
  return true;
}

function parse(file: string): Module {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports: Binding[] = [];
  const edges = new Set<string>();
  const hoisted = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) hoisted.add(statement.name.text);
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (typeOnly(statement)) continue;
      const target = resolveSpecifier(file, statement.moduleSpecifier.text);
      if (!target) continue;
      edges.add(target);
      if (!ts.isImportDeclaration(statement)) continue;
      const clause = statement.importClause;
      if (clause?.name) imports.push({ local: clause.name.text, imported: "default", from: target });
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) imports.push({ local: named.name.text, imported: "*", from: target });
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.isTypeOnly) continue;
          imports.push({ local: element.name.text, imported: (element.propertyName ?? element.name).text, from: target });
        }
      }
    }
  }
  const locals = new Set(imports.map((binding) => binding.local));
  const loadReads = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && locals.has(node.text) && isValueReference(node) && !insideDeferredCode(node)) loadReads.add(node.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const target = resolveSpecifier(file, node.arguments[0].text);
      if (target) edges.add(target);
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    visit(statement);
  }
  return { file, imports, edges, hoisted, loadReads };
}

function loops(modules: Map<string, Module>) {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const component = new Map<string, number>();
  let counter = 0;
  let components = 0;
  const strongConnect = (start: string) => {
    const work: { node: string; edges: string[]; next: number }[] = [];
    const enter = (node: string) => {
      index.set(node, counter);
      low.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
      work.push({ node, edges: [...(modules.get(node)?.edges ?? [])].filter((edge) => modules.has(edge)), next: 0 });
    };
    enter(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.next < frame.edges.length) {
        const edge = frame.edges[frame.next++];
        if (!index.has(edge)) enter(edge);
        else if (onStack.has(edge)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(edge)!));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.set(member, components);
        } while (member !== frame.node);
        components += 1;
      }
    }
  };
  for (const file of modules.keys()) if (!index.has(file)) strongConnect(file);
  return component;
}

function loadTimeReadsInsideLoops(dirs: string[]) {
  const modules = new Map(dirs.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((file) => [file, parse(file)] as const));
  const component = loops(modules);
  const findings: string[] = [];
  for (const entry of modules.values()) {
    for (const binding of entry.imports) {
      if (!entry.loadReads.has(binding.local)) continue;
      if (component.get(binding.from) !== component.get(entry.file)) continue;
      if (modules.get(binding.from)?.hoisted.has(binding.imported)) continue;
      findings.push(`${relative(ROOT, entry.file)} reads ${binding.imported} from ${relative(ROOT, binding.from)} while loading, inside an import loop`);
    }
  }
  return findings.sort();
}

describe("import loops", () => {
  it("never reads a value from a module in the same import loop while loading", () => {
    assert.deepEqual(loadTimeReadsInsideLoops(SCANNED), []);
  });

  it("catches a constant read while loading from a module in the same loop, and lets hoisted functions and later reads through", () => {
    assert.deepEqual(loadTimeReadsInsideLoops(["tests/fixtures/import-loop"]), [
      "tests/fixtures/import-loop/senders.ts reads AUTOMATED from tests/fixtures/import-loop/patterns.ts while loading, inside an import loop",
    ]);
  });

  it("keeps the shared constants modules free of imports", () => {
    for (const file of ["lib/mail/patterns.ts", "lib/enrichment/thresholds.ts", "lib/crm/invite-problems.ts", "lib/crm/task-doc-sql.ts", "lib/knowledge/limits.ts"]) {
      assert.equal(parse(join(ROOT, file)).edges.size, 0, `${file} imports nothing`);
    }
  });
});
