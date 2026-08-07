import { createHash } from "node:crypto";
import ts from "typescript";

function isProductionSourcePath(value) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value) ||
    !/^packages\/(?:core|mcp-server|vscode)\/src\//.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function assertDevOnlyDependency(packageManifest, dependency, expectedDevelopmentVersion) {
  for (const surface of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    const declaration = packageManifest?.[surface];
    const containsDependency = Array.isArray(declaration)
      ? declaration.includes(dependency)
      : declaration !== null && typeof declaration === "object" && Object.hasOwn(declaration, dependency);
    if (containsDependency) {
      throw new Error(`${dependency} must be absent from ${surface}`);
    }
  }
  const developmentVersion = packageManifest?.devDependencies?.[dependency];
  if (
    typeof expectedDevelopmentVersion !== "string" ||
    expectedDevelopmentVersion.trim() === "" ||
    developmentVersion !== expectedDevelopmentVersion
  ) {
    throw new Error(`${dependency} must have exact development dependency ${expectedDevelopmentVersion}`);
  }
}

export function assertNoHonoServeStatic(sources) {
  for (const { file, source } of sources) {
    if (/serve-static|serveStatic/.test(source)) {
      throw new Error(`Hono serve-static must remain unreachable: ${file}`);
    }
  }
}

export function assertContentAddressedTransformersSources(sources, sourceGuards) {
  const fail = (reason) => {
    throw new Error(`content-addressed Transformers guard failed: ${reason}`);
  };
  if (!Array.isArray(sources) || !Array.isArray(sourceGuards)) fail("malformed source guard input");

  const sourcesByPath = new Map();
  for (const sourceRecord of sources) {
    if (
      sourceRecord === null ||
      typeof sourceRecord !== "object" ||
      Array.isArray(sourceRecord) ||
      !isProductionSourcePath(sourceRecord.file) ||
      typeof sourceRecord.source !== "string"
    ) {
      fail("malformed production source record");
    }
    if (sourcesByPath.has(sourceRecord.file)) fail(`duplicate production source path: ${sourceRecord.file}`);
    if (/["'`]sharp(?:\/[^"'`]*)?["'`]/.test(sourceRecord.source)) {
      fail(`direct Sharp reference: ${sourceRecord.file}`);
    }
    sourcesByPath.set(sourceRecord.file, sourceRecord);
  }

  const guardsByPath = new Map();
  for (const guard of sourceGuards) {
    const fields =
      guard !== null && typeof guard === "object" && !Array.isArray(guard) ? Object.keys(guard).sort() : [];
    if (
      fields.length !== 2 ||
      fields[0] !== "path" ||
      fields[1] !== "sha256" ||
      typeof guard.sha256 !== "string" ||
      !isProductionSourcePath(guard.path) ||
      !/^[a-f0-9]{64}$/.test(guard.sha256)
    ) {
      fail("malformed source guard");
    }
    if (guardsByPath.has(guard.path)) fail(`duplicate guarded path: ${guard.path}`);
    guardsByPath.set(guard.path, guard);
  }

  const guardedSources = [];
  for (const guard of sourceGuards) {
    const sourceRecord = sourcesByPath.get(guard.path);
    if (!sourceRecord) fail(`guarded source is missing: ${guard.path}`);
    if (!sourceRecord.source.includes("@huggingface/transformers")) {
      fail(`guarded source has no Transformers reference: ${guard.path}`);
    }
    const actualHash = createHash("sha256").update(sourceRecord.source).digest("hex");
    if (actualHash !== guard.sha256) fail(`content hash mismatch: ${guard.path}`);
    guardedSources.push(sourceRecord);
  }

  for (const sourceRecord of sources) {
    if (sourceRecord.source.includes("@huggingface/transformers") && !guardsByPath.has(sourceRecord.file)) {
      fail(`unguarded Transformers source: ${sourceRecord.file}`);
    }
  }
  return guardedSources;
}

export function assertNoSharpOrImagePipeline(sources) {
  const transformersModule = "@huggingface/transformers";
  const approvedTransformersExports = new Set([
    "pipeline",
    "AutoTokenizer",
    "AutoModelForSequenceClassification",
    "env",
  ]);
  const forbiddenIdentifiers = new Set([
    "RawImage",
    "AutoProcessor",
    "AutoImageProcessor",
    "AutoFeatureExtractor",
    "ImageProcessor",
    "ImageFeatureExtractor",
    "image_processor",
    "imageProcessor",
  ]);
  const forbiddenTasks = new Set([
    "image-to-image",
    "image-to-text",
    "image-classification",
    "zero-shot-image-classification",
    "image-segmentation",
    "image-feature-extraction",
    "object-detection",
    "zero-shot-object-detection",
    "depth-estimation",
    "mask-generation",
    "video-classification",
  ]);
  const allowedPipelineTasks = new Set(["feature-extraction"]);
  for (const { file, source } of sources) {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const pipelineBindings = new Set(["pipeline"]);
    const namespaceBindings = new Set();
    let forbidden = false;
    const moduleName = (node) => (node && ts.isStringLiteralLike(node) ? node.text : undefined);
    const isSharpModule = (value) => typeof value === "string" && /^sharp(?:\/|$)/.test(value);
    const isTransformersModule = (value) =>
      typeof value === "string" && /^@huggingface\/transformers(?:\/|$)/.test(value);
    const unwrap = (node) => {
      while (
        node &&
        (ts.isAwaitExpression(node) ||
          ts.isParenthesizedExpression(node) ||
          ts.isAsExpression(node) ||
          ts.isTypeAssertionExpression(node) ||
          ts.isNonNullExpression(node))
      ) {
        node = node.expression;
      }
      return node;
    };
    const expressionKey = (node) => {
      node = unwrap(node);
      if (ts.isIdentifier(node)) return node.text;
      if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
      if (ts.isPropertyAccessExpression(node)) {
        const parent = expressionKey(node.expression);
        return parent ? `${parent}.${node.name.text}` : undefined;
      }
      return undefined;
    };
    const loadedModule = (node) => {
      node = unwrap(node);
      if (!ts.isCallExpression(node)) return undefined;
      if (
        node.expression.kind !== ts.SyntaxKind.ImportKeyword &&
        !(ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        return undefined;
      }
      return moduleName(node.arguments[0]);
    };
    const isTransformersLoaderCall = (node) => {
      node = unwrap(node);
      if (!ts.isCallExpression(node)) return false;
      const callee = expressionKey(node.expression);
      return callee === "loadTransformers" || callee?.endsWith(".loadTransformers");
    };
    const isNamespaceExpression = (node) => {
      const loaded = loadedModule(node);
      if (loaded !== undefined) return loaded === transformersModule;
      if (isTransformersLoaderCall(node)) return true;
      const key = expressionKey(node);
      return key !== undefined && namespaceBindings.has(key);
    };
    const validateExport = (name) => {
      if (!approvedTransformersExports.has(name)) forbidden = true;
      if (name === "pipeline") pipelineBindings.add(name);
    };

    const collectNamespaces = (node) => {
      if (ts.isImportDeclaration(node) && isTransformersModule(moduleName(node.moduleSpecifier))) {
        if (moduleName(node.moduleSpecifier) !== transformersModule || !node.importClause || node.importClause.name) {
          forbidden = true;
        }
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          namespaceBindings.add(bindings.name.text);
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const specifier of bindings.elements) {
            const imported = (specifier.propertyName ?? specifier.name).text;
            validateExport(imported);
            if (imported === "pipeline") pipelineBindings.add(specifier.name.text);
          }
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (loadedModule(node.initializer) === transformersModule || isTransformersLoaderCall(node.initializer))
      ) {
        namespaceBindings.add(node.name.text);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const loaded = loadedModule(node.right);
        if (loaded === transformersModule) {
          const key = expressionKey(node.left);
          if (key) namespaceBindings.add(key);
        }
      }
      ts.forEachChild(node, collectNamespaces);
    };
    collectNamespaces(sourceFile);

    const collectDestructuredExports = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isNamespaceExpression(node.initializer)
      ) {
        for (const element of node.name.elements) {
          if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
            forbidden = true;
            continue;
          }
          const imported = element.propertyName
            ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
              ? element.propertyName.text
              : undefined
            : element.name.text;
          if (!imported) {
            forbidden = true;
            continue;
          }
          validateExport(imported);
          if (imported === "pipeline") pipelineBindings.add(element.name.text);
        }
      }
      ts.forEachChild(node, collectDestructuredExports);
    };
    collectDestructuredExports(sourceFile);

    const namespaceExport = (node) => {
      node = unwrap(node);
      if (ts.isPropertyAccessExpression(node) && isNamespaceExpression(node.expression)) return node.name.text;
      if (ts.isElementAccessExpression(node) && isNamespaceExpression(node.expression)) {
        return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
      }
      return undefined;
    };

    const inspect = (node) => {
      if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) forbidden = true;
      if (ts.isStringLiteralLike(node) && forbiddenTasks.has(node.text)) forbidden = true;
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const importedModule = moduleName(node.moduleReference.expression);
        if (isSharpModule(importedModule) || isTransformersModule(importedModule)) forbidden = true;
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        isSharpModule(moduleName(node.moduleSpecifier))
      ) {
        forbidden = true;
      }
      if (ts.isExportDeclaration(node) && isTransformersModule(moduleName(node.moduleSpecifier))) forbidden = true;
      const accessedExport = namespaceExport(node);
      if (
        accessedExport === null ||
        (accessedExport !== undefined && !approvedTransformersExports.has(accessedExport))
      ) {
        forbidden = true;
      }
      if (ts.isCallExpression(node)) {
        const calledPipeline =
          (ts.isIdentifier(node.expression) && pipelineBindings.has(node.expression.text)) ||
          namespaceExport(node.expression) === "pipeline";
        if (calledPipeline) {
          const task = node.arguments[0];
          if (!task || !ts.isStringLiteralLike(task) || !allowedPipelineTasks.has(task.text)) forbidden = true;
        }
        const loaded = loadedModule(node);
        if (isTransformersModule(loaded) && loaded !== transformersModule) forbidden = true;
        if (
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
          isSharpModule(moduleName(node.arguments[0]))
        ) {
          forbidden = true;
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(sourceFile);
    if (forbidden) {
      throw new Error(`Sharp and image pipelines must remain unreachable: ${file}`);
    }
  }
}
