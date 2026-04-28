/**
 * Tree-sitter Parser
 * ==================
 *
 * AST-based code parser using tree-sitter for accurate symbol extraction.
 * Supports multiple languages: C++, C#, Java, Lua, Python, TypeScript.
 *
 * Dependencies:
 * - tree-sitter: Core parser library
 * - tree-sitter-cpp: C++ grammar
 * - tree-sitter-c-sharp: C# grammar
 * - tree-sitter-java: Java grammar
 * - tree-sitter-lua: Lua grammar
 * - tree-sitter-python: Python grammar
 * - tree-sitter-typescript: TypeScript/JavaScript grammar
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodeGraphNode, CodeGraphEdge, GraphNodeType, GraphEdgeType } from '../types';
import {
	getLanguageConfig,
	getLanguageName,
	isTestFile,
	detectTestFramework,
} from './language-registry';

// Tree-sitter will be dynamically imported to avoid bundling issues
let Parser: any;
let parserCache: Map<string, any> = new Map();

// =============================================================================
// Parser Initialization
// =============================================================================

/**
 * Initialize tree-sitter parser (lazy loading).
 */
async function initializeParser(): Promise<void> {
	if (Parser) return;

	try {
		// Dynamic import to avoid bundling issues
		const treeSitter = await import('tree-sitter');
		Parser = treeSitter.default || treeSitter;
	} catch (error) {
		console.error('[TreeSitterParser] Failed to load tree-sitter:', error);
		throw new Error(
			'tree-sitter not installed. Run: npm install tree-sitter tree-sitter-cpp tree-sitter-c-sharp tree-sitter-java tree-sitter-lua tree-sitter-python tree-sitter-typescript',
		);
	}
}

/**
 * Get or create parser for a language.
 */
async function getParser(language: string): Promise<any> {
	await initializeParser();

	if (parserCache.has(language)) {
		return parserCache.get(language);
	}

	const parser = new Parser();

	try {
		let languageModule: any;

		switch (language) {
			case 'cpp':
			case 'c++':
				languageModule = await import('tree-sitter-cpp');
				break;
			case 'csharp':
			case 'c#':
				languageModule = await import('tree-sitter-c-sharp');
				break;
			case 'java':
				languageModule = await import('tree-sitter-java');
				break;
			case 'lua':
				languageModule = await import('tree-sitter-lua');
				break;
			case 'python':
				languageModule = await import('tree-sitter-python');
				break;
			case 'typescript':
			case 'javascript':
			case 'tsx':
				const tsModule = await import('tree-sitter-typescript');
				languageModule = language === 'tsx' ? tsModule.tsx : tsModule.typescript;
				break;
			default:
				throw new Error(`Unsupported language: ${language}`);
		}

		parser.setLanguage(languageModule);
		parserCache.set(language, parser);

		return parser;
	} catch (error) {
		console.error(`[TreeSitterParser] Failed to load grammar for ${language}:`, error);
		throw new Error(`Failed to load tree-sitter grammar for ${language}. Install: npm install tree-sitter-${language}`);
	}
}

// =============================================================================
// File Parsing
// =============================================================================

export interface ParseResult {
	nodes: CodeGraphNode[];
	edges: CodeGraphEdge[];
}

/**
 * Parse a source file and extract nodes and edges.
 *
 * @param projectId - Project identifier
 * @param filePath - Absolute path to the file
 * @param content - File content (optional, will read from disk if not provided)
 * @returns Parsed nodes and edges
 */
export async function parseFile(
	projectId: string,
	filePath: string,
	content?: string,
): Promise<ParseResult> {
	// Read file content if not provided
	if (!content) {
		try {
			content = fs.readFileSync(filePath, 'utf-8');
		} catch (error) {
			console.error(`[TreeSitterParser] Failed to read file ${filePath}:`, error);
			return { nodes: [], edges: [] };
		}
	}

	// Detect language from file extension
	const extension = path.extname(filePath);
	const language = getLanguageName(extension);

	if (!language) {
		console.warn(`[TreeSitterParser] Unsupported file extension: ${extension}`);
		return { nodes: [], edges: [] };
	}

	// Get language configuration
	const config = getLanguageConfig(extension);
	if (!config) {
		console.warn(`[TreeSitterParser] No configuration for language: ${language}`);
		return { nodes: [], edges: [] };
	}

	try {
		// Get parser for this language
		const parser = await getParser(language);

		// Parse the file
		const tree = parser.parse(content);

		// Extract nodes and edges
		const nodes: CodeGraphNode[] = [];
		const edges: CodeGraphEdge[] = [];

		// Extract file node
		const fileNode = createFileNode(projectId, filePath, language, content);
		nodes.push(fileNode);

		// Extract classes/interfaces
		if (config.queries.classes) {
			const classNodes = extractClasses(projectId, filePath, language, tree, content);
			nodes.push(...classNodes);

			// Create CONTAINS edges from file to classes
			for (const classNode of classNodes) {
				edges.push(
					createEdge(projectId, fileNode.id, classNode.id, 'contains', {
						lineNumber: classNode.startLine,
					}),
				);
			}
		}

		// Extract functions/methods
		if (config.queries.functions) {
			const functionNodes = extractFunctions(projectId, filePath, language, tree, content);
			nodes.push(...functionNodes);

			// Create CONTAINS edges from file to functions
			for (const functionNode of functionNodes) {
				edges.push(
					createEdge(projectId, fileNode.id, functionNode.id, 'contains', {
						lineNumber: functionNode.startLine,
					}),
				);
			}
		}

		// Extract imports
		if (config.queries.imports) {
			const importEdges = extractImports(projectId, filePath, fileNode.id, tree, content);
			edges.push(...importEdges);
		}

		// Detect if this is a test file
		if (isTestFile(filePath)) {
			fileNode.metadata.isTest = true;
			const framework = detectTestFramework(content, language);
			if (framework) {
				fileNode.metadata.testFramework = framework;
			}
		}

		return { nodes, edges };
	} catch (error) {
		console.error(`[TreeSitterParser] Failed to parse ${filePath}:`, error);
		return { nodes: [], edges: [] };
	}
}

// =============================================================================
// Node Extraction
// =============================================================================

/**
 * Create a file node.
 */
function createFileNode(
	projectId: string,
	filePath: string,
	language: string,
	content: string,
): CodeGraphNode {
	const lines = content.split('\n').length;

	return {
		id: generateNodeId(projectId, filePath, path.basename(filePath), 'file'),
		projectId,
		type: 'file',
		label: path.basename(filePath),
		filePath,
		language,
		startLine: 1,
		endLine: lines,
		metadata: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

/**
 * Extract class/interface nodes from AST.
 */
function extractClasses(
	projectId: string,
	filePath: string,
	language: string,
	tree: any,
	content: string,
): CodeGraphNode[] {
	const nodes: CodeGraphNode[] = [];
	const lines = content.split('\n');

	// Walk the AST to find class declarations
	walkTree(tree.rootNode, (node: any) => {
		const nodeType = node.type;

		// Check if this is a class-like node
		const classTypes = [
			'class_declaration',
			'class_specifier',
			'interface_declaration',
			'struct_declaration',
			'struct_specifier',
			'enum_declaration',
			'record_declaration',
		];

		if (classTypes.includes(nodeType)) {
			const nameNode = findChildByType(node, ['identifier', 'type_identifier']);
			if (!nameNode) return;

			const className = nameNode.text;
			const startLine = node.startPosition.row + 1;
			const endLine = node.endPosition.row + 1;

			nodes.push({
				id: generateNodeId(projectId, filePath, className, 'class'),
				projectId,
				type: 'class',
				label: className,
				filePath,
				language,
				startLine,
				endLine,
				metadata: {
					nodeType,
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		}
	});

	return nodes;
}

/**
 * Extract function/method nodes from AST.
 */
function extractFunctions(
	projectId: string,
	filePath: string,
	language: string,
	tree: any,
	content: string,
): CodeGraphNode[] {
	const nodes: CodeGraphNode[] = [];

	// Walk the AST to find function declarations
	walkTree(tree.rootNode, (node: any) => {
		const nodeType = node.type;

		// Check if this is a function-like node
		const functionTypes = [
			'function_declaration',
			'function_definition',
			'method_declaration',
			'method_definition',
			'constructor_declaration',
		];

		if (functionTypes.includes(nodeType)) {
			const nameNode = findChildByType(node, ['identifier', 'property_identifier']);
			if (!nameNode) return;

			const functionName = nameNode.text;
			const startLine = node.startPosition.row + 1;
			const endLine = node.endPosition.row + 1;

			// Extract parameters
			const paramsNode = findChildByType(node, [
				'parameters',
				'parameter_list',
				'formal_parameters',
			]);
			const params = paramsNode ? paramsNode.text : '';

			nodes.push({
				id: generateNodeId(projectId, filePath, functionName, 'function'),
				projectId,
				type: 'function',
				label: functionName,
				filePath,
				language,
				startLine,
				endLine,
				signature: `${functionName}${params}`,
				metadata: {
					nodeType,
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		}
	});

	return nodes;
}

/**
 * Extract import edges from AST.
 */
function extractImports(
	projectId: string,
	filePath: string,
	fileNodeId: string,
	tree: any,
	content: string,
): CodeGraphEdge[] {
	const edges: CodeGraphEdge[] = [];

	// Walk the AST to find import statements
	walkTree(tree.rootNode, (node: any) => {
		const nodeType = node.type;

		// Check if this is an import-like node
		const importTypes = [
			'import_statement',
			'import_declaration',
			'import_from_statement',
			'using_directive',
			'preproc_include',
		];

		if (importTypes.includes(nodeType)) {
			// Extract import source/module
			const sourceNode = findChildByType(node, ['string', 'string_literal', 'qualified_name', 'scoped_identifier']);
			if (!sourceNode) return;

			const importSource = sourceNode.text.replace(/['"]/g, '');
			const lineNumber = node.startPosition.row + 1;

			// Create a placeholder target node ID (will be resolved later)
			const targetId = generateNodeId(projectId, importSource, importSource, 'file');

			edges.push(
				createEdge(projectId, fileNodeId, targetId, 'imports', {
					lineNumber,
					importSource,
				}),
			);
		}
	});

	return edges;
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Walk the AST tree and call visitor for each node.
 */
function walkTree(node: any, visitor: (node: any) => void): void {
	visitor(node);

	for (let i = 0; i < node.childCount; i++) {
		walkTree(node.child(i), visitor);
	}
}

/**
 * Find first child node with one of the given types.
 */
function findChildByType(node: any, types: string[]): any | null {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (types.includes(child.type)) {
			return child;
		}
	}
	return null;
}

/**
 * Generate a unique node ID.
 */
function generateNodeId(projectId: string, filePath: string, label: string, type: string): string {
	const crypto = require('node:crypto');
	return crypto
		.createHash('sha256')
		.update(`${projectId}:${filePath}:${label}:${type}`)
		.digest('hex')
		.slice(0, 16);
}

/**
 * Create an edge.
 */
function createEdge(
	projectId: string,
	fromId: string,
	toId: string,
	type: GraphEdgeType,
	metadata: Record<string, unknown> = {},
): CodeGraphEdge {
	const crypto = require('node:crypto');
	const id = crypto
		.createHash('sha256')
		.update(`${projectId}:${fromId}:${toId}:${type}`)
		.digest('hex')
		.slice(0, 16);

	return {
		id,
		projectId,
		fromId,
		toId,
		type,
		weight: 1.0,
		metadata,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}
