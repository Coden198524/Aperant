import { basename } from 'node:path';
import type { GraphEdgeType, GraphNodeType } from './types.js';

export interface AutocodeTreeSitterPoint {
  row: number;
  column: number;
}

export interface AutocodeTreeSitterNode {
  type: string;
  text: string;
  childCount: number;
  namedChildCount: number;
  startPosition: AutocodeTreeSitterPoint;
  endPosition: AutocodeTreeSitterPoint;
  child(index: number): AutocodeTreeSitterNode | null;
  namedChild(index: number): AutocodeTreeSitterNode | null;
}

export interface AutocodeTreeSitterTree {
  rootNode: AutocodeTreeSitterNode;
}

export interface AutocodeTreeSitterParser {
  parse(content: string): AutocodeTreeSitterTree | null;
}

export interface ExtractedNode {
  type: GraphNodeType;
  label: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  metadata?: Record<string, unknown>;
}

export interface ExtractedEdge {
  fromLabel: string;
  toLabel: string;
  type: GraphEdgeType;
  metadata?: Record<string, unknown>;
}

export interface ExtractionResult {
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
}

export interface ASTChunk {
  content: string;
  filePath: string;
  language: string;
  chunkType: 'function' | 'class' | 'module' | 'prose';
  startLine: number;
  endLine: number;
  name?: string;
  contextPrefix: string;
}

const FALLBACK_CHUNK_SIZE = 100;

function extractIdentifier(node: AutocodeTreeSitterNode): string | null {
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child) {
      continue;
    }
    if (child.type === 'identifier' || child.type === 'property_identifier' || child.type === 'type_identifier') {
      return child.text;
    }
  }

  if (node.namedChildCount > 0) {
    const firstNamed = node.namedChild(0);
    if (firstNamed && (firstNamed.type === 'identifier' || firstNamed.type === 'type_identifier')) {
      return firstNamed.text;
    }
  }

  return null;
}

function extractImportSource(node: AutocodeTreeSitterNode): string | null {
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child) {
      continue;
    }
    if (child.type === 'string' || child.type === 'string_fragment' || child.type === 'module_specifier') {
      return child.text.replace(/['"]/g, '');
    }
  }

  return null;
}

function extractNamedImports(node: AutocodeTreeSitterNode): string[] {
  const symbols: string[] = [];

  const walkForImports = (current: AutocodeTreeSitterNode): void => {
    if (current.type === 'import_specifier') {
      for (let index = 0; index < current.childCount; index++) {
        const child = current.child(index);
        if (child?.type === 'identifier') {
          symbols.push(child.text);
          break;
        }
      }
    }

    for (let index = 0; index < current.childCount; index++) {
      const child = current.child(index);
      if (child) {
        walkForImports(child);
      }
    }
  };

  walkForImports(node);
  return [...new Set(symbols)];
}

function extractCallTarget(node: AutocodeTreeSitterNode): string | null {
  const fn = node.namedChild(0);
  if (!fn) {
    return null;
  }

  if (fn.type === 'identifier' || fn.type === 'member_expression') {
    return fn.text;
  }

  return null;
}

export class ASTExtractor {
  extract(tree: AutocodeTreeSitterTree, filePath: string, language: string): ExtractionResult {
    const nodes: ExtractedNode[] = [];
    const edges: ExtractedEdge[] = [];
    const fileLabel = filePath;

    nodes.push({
      type: 'file',
      label: fileLabel,
      filePath,
      language,
      startLine: 1,
      endLine: tree.rootNode.endPosition.row + 1,
    });

    const containerStack: string[] = [fileLabel];
    const pushContainer = (label: string): number => containerStack.push(label);
    const popContainer = (): string | undefined => (containerStack.length > 1 ? containerStack.pop() : undefined);
    const currentContainer = (): string => containerStack[containerStack.length - 1];

    this.walkAndExtract(
      tree.rootNode,
      filePath,
      language,
      nodes,
      edges,
      containerStack,
      pushContainer,
      popContainer,
      currentContainer
    );

    return { nodes, edges };
  }

  private walkAndExtract(
    node: AutocodeTreeSitterNode,
    filePath: string,
    language: string,
    nodes: ExtractedNode[],
    edges: ExtractedEdge[],
    containerStack: string[],
    pushContainer: (label: string) => void,
    popContainer: () => void,
    currentContainer: () => string
  ): void {
    const fileLabel = filePath;

    switch (node.type) {
      case 'import_statement': {
        const source = extractImportSource(node);
        if (source) {
          edges.push({ fromLabel: fileLabel, toLabel: source, type: 'imports' });

          for (const symbol of extractNamedImports(node)) {
            edges.push({ fromLabel: fileLabel, toLabel: `${source}:${symbol}`, type: 'imports_symbol' });
          }
        }
        break;
      }

      case 'import_from_statement': {
        let moduleName: string | null = null;
        const importedNames: string[] = [];
        for (let index = 0; index < node.childCount; index++) {
          const child = node.child(index);
          if (!child) {
            continue;
          }
          if (child.type === 'dotted_name' && !moduleName) {
            moduleName = child.text;
          } else if (child.type === 'identifier') {
            importedNames.push(child.text);
          }
        }
        if (moduleName) {
          edges.push({ fromLabel: fileLabel, toLabel: moduleName, type: 'imports' });
          for (const name of importedNames) {
            edges.push({ fromLabel: fileLabel, toLabel: `${moduleName}:${name}`, type: 'imports_symbol' });
          }
        }
        break;
      }

      case 'function_declaration':
      case 'function_definition': {
        const name = extractIdentifier(node);
        if (name) {
          const label = `${fileLabel}:${name}`;
          nodes.push(createExtractedNode('function', label, filePath, language, node));
          edges.push({ fromLabel: label, toLabel: currentContainer(), type: 'defined_in' });
          pushContainer(label);
          this.walkChildren(node, filePath, language, nodes, edges, containerStack, pushContainer, popContainer, currentContainer);
          popContainer();
          return;
        }
        break;
      }

      case 'method_definition':
      case 'function_signature': {
        const name = extractIdentifier(node);
        if (name) {
          const label = `${fileLabel}:${name}`;
          nodes.push(createExtractedNode('function', label, filePath, language, node));
          edges.push({ fromLabel: label, toLabel: currentContainer(), type: 'defined_in' });
          pushContainer(label);
          this.walkChildren(node, filePath, language, nodes, edges, containerStack, pushContainer, popContainer, currentContainer);
          popContainer();
          return;
        }
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        for (let index = 0; index < node.namedChildCount; index++) {
          const decl = node.namedChild(index);
          if (!decl || decl.type !== 'variable_declarator') {
            continue;
          }
          const nameNode = decl.namedChild(0);
          const valueNode = decl.namedChild(1);
          if (!nameNode || !valueNode) {
            continue;
          }
          if (valueNode.type === 'arrow_function' || valueNode.type === 'function') {
            const label = `${fileLabel}:${nameNode.text}`;
            nodes.push(createExtractedNode('function', label, filePath, language, node));
            edges.push({ fromLabel: label, toLabel: currentContainer(), type: 'defined_in' });
          }
        }
        break;
      }

      case 'class_declaration':
      case 'class_definition': {
        const name = extractIdentifier(node);
        if (name) {
          const label = `${fileLabel}:${name}`;
          nodes.push(createExtractedNode('class', label, filePath, language, node));
          edges.push({ fromLabel: label, toLabel: currentContainer(), type: 'defined_in' });
          this.extractClassHeritage(node, label, fileLabel, edges);
          pushContainer(label);
          this.walkChildren(node, filePath, language, nodes, edges, containerStack, pushContainer, popContainer, currentContainer);
          popContainer();
          return;
        }
        break;
      }

      case 'interface_declaration': {
        const name = extractIdentifier(node);
        if (name) {
          const label = `${fileLabel}:${name}`;
          nodes.push(createExtractedNode('interface', label, filePath, language, node));
          edges.push({ fromLabel: label, toLabel: currentContainer(), type: 'defined_in' });
        }
        break;
      }

      case 'type_alias_declaration': {
        const name = extractIdentifier(node);
        if (name) {
          const label = `${fileLabel}:${name}`;
          nodes.push(createExtractedNode('type_alias', label, filePath, language, node));
          edges.push({ fromLabel: label, toLabel: currentContainer(), type: 'defined_in' });
        }
        break;
      }

      case 'enum_declaration': {
        const name = extractIdentifier(node);
        if (name) {
          const label = `${fileLabel}:${name}`;
          nodes.push(createExtractedNode('enum', label, filePath, language, node));
          edges.push({ fromLabel: label, toLabel: currentContainer(), type: 'defined_in' });
        }
        break;
      }

      case 'call_expression': {
        const target = extractCallTarget(node);
        const container = currentContainer();
        if (target && container !== filePath) {
          edges.push({ fromLabel: container, toLabel: target, type: 'calls' });
        }
        break;
      }

      case 'export_statement': {
        for (let index = 0; index < node.namedChildCount; index++) {
          const child = node.namedChild(index);
          if (!child) {
            continue;
          }
          if (
            child.type === 'function_declaration' ||
            child.type === 'class_declaration' ||
            child.type === 'interface_declaration'
          ) {
            const name = extractIdentifier(child);
            if (name) {
              edges.push({ fromLabel: fileLabel, toLabel: `${fileLabel}:${name}`, type: 'exports' });
            }
          }
        }
        break;
      }
    }

    this.walkChildren(node, filePath, language, nodes, edges, containerStack, pushContainer, popContainer, currentContainer);
  }

  private extractClassHeritage(
    node: AutocodeTreeSitterNode,
    label: string,
    fileLabel: string,
    edges: ExtractedEdge[]
  ): void {
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      if (!child || child.type !== 'class_heritage') {
        continue;
      }

      for (let childIndex = 0; childIndex < child.childCount; childIndex++) {
        const heritageChild = child.child(childIndex);
        if (heritageChild?.type !== 'extends_clause' && heritageChild?.type !== 'implements_clause') {
          continue;
        }

        for (let baseIndex = 0; baseIndex < heritageChild.childCount; baseIndex++) {
          const base = heritageChild.child(baseIndex);
          if (base?.type === 'identifier' || base?.type === 'type_identifier') {
            edges.push({
              fromLabel: label,
              toLabel: `${fileLabel}:${base.text}`,
              type: heritageChild.type === 'extends_clause' ? 'extends' : 'implements',
            });
          }
        }
      }
    }
  }

  private walkChildren(
    node: AutocodeTreeSitterNode,
    filePath: string,
    language: string,
    nodes: ExtractedNode[],
    edges: ExtractedEdge[],
    containerStack: string[],
    pushContainer: (label: string) => void,
    popContainer: () => void,
    currentContainer: () => string
  ): void {
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      if (child) {
        this.walkAndExtract(child, filePath, language, nodes, edges, containerStack, pushContainer, popContainer, currentContainer);
      }
    }
  }
}

function createExtractedNode(
  type: GraphNodeType,
  label: string,
  filePath: string,
  language: string,
  node: AutocodeTreeSitterNode
): ExtractedNode {
  return {
    type,
    label,
    filePath,
    language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function nodeTypeToChunkType(nodeType: string): 'function' | 'class' {
  const classTypes = new Set([
    'class_declaration',
    'class_definition',
    'interface_declaration',
    'enum_declaration',
    'struct_item',
  ]);
  return classTypes.has(nodeType) ? 'class' : 'function';
}

function extractChunkName(node: AutocodeTreeSitterNode): string | undefined {
  return extractIdentifier(node) ?? undefined;
}

function buildContextPrefix(
  filePath: string,
  chunkType: 'function' | 'class' | 'module' | 'prose',
  name: string | undefined,
  startLine: number,
  endLine: number
): string {
  const parts: string[] = [`File: ${filePath}`];
  if (chunkType !== 'module' && chunkType !== 'prose' && name) {
    parts.push(`${chunkType}: ${name}`);
  }
  parts.push(`Lines: ${startLine}-${endLine}`);
  return parts.join(' | ');
}

function fallbackChunks(content: string, filePath: string): ASTChunk[] {
  const lines = content.split('\n');
  const chunks: ASTChunk[] = [];

  for (let index = 0; index < lines.length; index += FALLBACK_CHUNK_SIZE) {
    const startLine = index + 1;
    const endLine = Math.min(index + FALLBACK_CHUNK_SIZE, lines.length);
    const chunkContent = lines.slice(index, index + FALLBACK_CHUNK_SIZE).join('\n');

    chunks.push({
      content: chunkContent,
      filePath,
      language: 'text',
      chunkType: 'prose',
      startLine,
      endLine,
      contextPrefix: buildContextPrefix(filePath, 'prose', undefined, startLine, endLine),
    });
  }

  return chunks;
}

const CHUNK_NODE_TYPES: Record<string, Set<string>> = {
  typescript: new Set([
    'function_declaration',
    'class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'export_statement',
  ]),
  tsx: new Set([
    'function_declaration',
    'class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'export_statement',
  ]),
  javascript: new Set(['function_declaration', 'class_declaration', 'export_statement']),
  python: new Set(['function_definition', 'class_definition', 'decorated_definition']),
  rust: new Set(['function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item']),
  go: new Set(['function_declaration', 'method_declaration', 'type_declaration']),
  java: new Set(['class_declaration', 'method_declaration', 'interface_declaration', 'enum_declaration']),
};

function isArrowFunctionDecl(node: AutocodeTreeSitterNode): { name: string } | null {
  if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') {
    return null;
  }

  for (let index = 0; index < node.namedChildCount; index++) {
    const decl = node.namedChild(index);
    if (!decl || decl.type !== 'variable_declarator') {
      continue;
    }
    const nameNode = decl.namedChild(0);
    const valueNode = decl.namedChild(1);
    if (!nameNode || !valueNode) {
      continue;
    }
    if (valueNode.type === 'arrow_function' || valueNode.type === 'function') {
      return { name: nameNode.text };
    }
  }

  return null;
}

export async function chunkFileByAST(
  filePath: string,
  content: string,
  lang: string,
  parser: AutocodeTreeSitterParser
): Promise<ASTChunk[]> {
  if (!content.trim()) {
    return [];
  }

  const chunkNodeTypes = CHUNK_NODE_TYPES[lang];
  if (!chunkNodeTypes) {
    return fallbackChunks(content, filePath);
  }

  let tree: AutocodeTreeSitterTree | null;
  try {
    tree = parser.parse(content);
  } catch {
    return fallbackChunks(content, filePath);
  }

  if (!tree) {
    return fallbackChunks(content, filePath);
  }

  const lines = content.split('\n');
  const chunks: ASTChunk[] = [];
  const coveredRanges: Array<{ start: number; end: number }> = [];
  const rootNode = tree.rootNode;

  for (let index = 0; index < rootNode.childCount; index++) {
    const child = rootNode.child(index);
    if (!child) {
      continue;
    }

    let chunkName: string | undefined;
    let chunkType: 'function' | 'class' | 'module' | 'prose' = 'function';
    let shouldChunk = false;

    if (chunkNodeTypes.has(child.type)) {
      shouldChunk = true;
      chunkName = extractChunkName(child);
      chunkType = nodeTypeToChunkType(child.type);

      if (child.type === 'export_statement') {
        const exported = child.namedChild(0);
        if (exported) {
          chunkName = extractChunkName(exported);
          chunkType = nodeTypeToChunkType(exported.type);
        }
      }
    } else {
      const arrowDecl = isArrowFunctionDecl(child);
      if (arrowDecl) {
        shouldChunk = true;
        chunkName = arrowDecl.name;
        chunkType = 'function';
      }
    }

    if (shouldChunk) {
      const startLine = child.startPosition.row + 1;
      const endLine = child.endPosition.row + 1;
      chunks.push({
        content: lines.slice(startLine - 1, endLine).join('\n'),
        filePath,
        language: lang,
        chunkType,
        startLine,
        endLine,
        name: chunkName,
        contextPrefix: buildContextPrefix(filePath, chunkType, chunkName, startLine, endLine),
      });
      coveredRanges.push({ start: startLine, end: endLine });
    }
  }

  const uncoveredLines = collectUncoveredLines(lines, coveredRanges);
  if (uncoveredLines.length > 0) {
    chunks.push(...groupLinesIntoChunks(uncoveredLines, filePath, lang));
  }

  if (chunks.length === 0) {
    return fallbackChunks(content, filePath);
  }

  return chunks.sort((a, b) => a.startLine - b.startLine);
}

function collectUncoveredLines(lines: string[], covered: Array<{ start: number; end: number }>): number[] {
  const uncovered: number[] = [];
  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber++) {
    const inCovered = covered.some((range) => lineNumber >= range.start && lineNumber <= range.end);
    if (!inCovered && lines[lineNumber - 1].trim()) {
      uncovered.push(lineNumber);
    }
  }
  return uncovered;
}

function groupLinesIntoChunks(lineNumbers: number[], filePath: string, lang: string): ASTChunk[] {
  if (lineNumbers.length === 0) {
    return [];
  }

  const chunks: ASTChunk[] = [];
  let groupStart = lineNumbers[0];
  let groupEnd = lineNumbers[0];

  for (let index = 1; index < lineNumbers.length; index++) {
    if (lineNumbers[index] === groupEnd + 1) {
      groupEnd = lineNumbers[index];
    } else {
      chunks.push(buildModuleChunk(groupStart, groupEnd, filePath, lang));
      groupStart = lineNumbers[index];
      groupEnd = lineNumbers[index];
    }
  }
  chunks.push(buildModuleChunk(groupStart, groupEnd, filePath, lang));

  return chunks;
}

function buildModuleChunk(startLine: number, endLine: number, filePath: string, lang: string): ASTChunk {
  const fileName = basename(filePath);
  return {
    content: '',
    filePath,
    language: lang,
    chunkType: 'module',
    startLine,
    endLine,
    name: fileName,
    contextPrefix: buildContextPrefix(filePath, 'module', fileName, startLine, endLine),
  };
}
