/**
 * Language Registry
 * =================
 *
 * Configuration for supported programming languages.
 * Defines file extensions, Tree-sitter queries, and parsing rules.
 *
 * Language support priority:
 * 1. C++ (.cpp, .cc, .cxx, .h, .hpp)
 * 2. C# (.cs)
 * 3. Java (.java)
 * 4. Lua (.lua)
 * 5. Python (.py)
 * 6. TypeScript (.ts, .tsx, .js, .jsx)
 */

import type { LanguageConfig } from '../types';

// =============================================================================
// Language Configurations
// =============================================================================

/**
 * C++ configuration.
 *
 * Supports: .cpp, .cc, .cxx, .h, .hpp
 */
export const CPP_CONFIG: LanguageConfig = {
	extensions: ['.cpp', '.cc', '.cxx', '.h', '.hpp'],
	parserName: 'cpp',
	queries: {
		// Classes and structs
		classes: `
			(class_specifier
				name: (type_identifier) @class.name
				body: (field_declaration_list) @class.body
			) @class.definition

			(struct_specifier
				name: (type_identifier) @struct.name
				body: (field_declaration_list) @struct.body
			) @struct.definition
		`,

		// Functions and methods
		functions: `
			(function_definition
				declarator: (function_declarator
					declarator: (identifier) @function.name
					parameters: (parameter_list) @function.params
				)
			) @function.definition

			(function_definition
				declarator: (function_declarator
					declarator: (qualified_identifier
						name: (identifier) @method.name
					)
					parameters: (parameter_list) @method.params
				)
			) @method.definition
		`,

		// Imports (includes)
		imports: `
			(preproc_include
				path: (string_literal) @include.path
			) @include.statement

			(preproc_include
				path: (system_lib_string) @include.system
			) @include.system.statement
		`,

		// Exports (namespace exports)
		exports: `
			(namespace_definition
				name: (identifier) @namespace.name
			) @namespace.definition
		`,
	},
};

/**
 * C# configuration.
 *
 * Supports: .cs
 */
export const CSHARP_CONFIG: LanguageConfig = {
	extensions: ['.cs'],
	parserName: 'c_sharp',
	queries: {
		// Classes and interfaces
		classes: `
			(class_declaration
				name: (identifier) @class.name
				bases: (base_list)? @class.bases
			) @class.definition

			(interface_declaration
				name: (identifier) @interface.name
			) @interface.definition

			(struct_declaration
				name: (identifier) @struct.name
			) @struct.definition

			(record_declaration
				name: (identifier) @record.name
			) @record.definition
		`,

		// Methods and functions
		functions: `
			(method_declaration
				name: (identifier) @method.name
				parameters: (parameter_list) @method.params
			) @method.definition

			(constructor_declaration
				name: (identifier) @constructor.name
				parameters: (parameter_list) @constructor.params
			) @constructor.definition

			(local_function_statement
				name: (identifier) @function.name
				parameters: (parameter_list) @function.params
			) @function.definition
		`,

		// Imports (using statements)
		imports: `
			(using_directive
				name: (qualified_name) @using.name
			) @using.statement

			(using_directive
				name: (identifier) @using.simple
			) @using.simple.statement
		`,

		// Exports (public members)
		exports: `
			(class_declaration
				(modifier "public") @export.public
				name: (identifier) @export.class
			)

			(method_declaration
				(modifier "public") @export.public
				name: (identifier) @export.method
			)
		`,
	},
};

/**
 * Java configuration.
 *
 * Supports: .java
 */
export const JAVA_CONFIG: LanguageConfig = {
	extensions: ['.java'],
	parserName: 'java',
	queries: {
		// Classes and interfaces
		classes: `
			(class_declaration
				name: (identifier) @class.name
				superclass: (superclass)? @class.extends
				interfaces: (super_interfaces)? @class.implements
			) @class.definition

			(interface_declaration
				name: (identifier) @interface.name
			) @interface.definition

			(enum_declaration
				name: (identifier) @enum.name
			) @enum.definition

			(record_declaration
				name: (identifier) @record.name
			) @record.definition
		`,

		// Methods and constructors
		functions: `
			(method_declaration
				name: (identifier) @method.name
				parameters: (formal_parameters) @method.params
			) @method.definition

			(constructor_declaration
				name: (identifier) @constructor.name
				parameters: (formal_parameters) @constructor.params
			) @constructor.definition
		`,

		// Imports
		imports: `
			(import_declaration
				(scoped_identifier) @import.scoped
			) @import.statement

			(import_declaration
				(identifier) @import.simple
			) @import.simple.statement
		`,

		// Exports (public members)
		exports: `
			(class_declaration
				(modifiers (modifier "public")) @export.public
				name: (identifier) @export.class
			)

			(method_declaration
				(modifiers (modifier "public")) @export.public
				name: (identifier) @export.method
			)
		`,
	},
};

/**
 * Lua configuration.
 *
 * Supports: .lua
 */
export const LUA_CONFIG: LanguageConfig = {
	extensions: ['.lua'],
	parserName: 'lua',
	queries: {
		// Tables (Lua's equivalent of classes)
		classes: `
			(variable_declaration
				(assignment_statement
					(variable_list
						name: (identifier) @table.name
					)
					(expression_list
						value: (table_constructor) @table.value
					)
				)
			) @table.definition
		`,

		// Functions
		functions: `
			(function_declaration
				name: (identifier) @function.name
				parameters: (parameters) @function.params
			) @function.definition

			(function_declaration
				name: (dot_index_expression
					field: (identifier) @method.name
				)
				parameters: (parameters) @method.params
			) @method.definition

			(assignment_statement
				(variable_list
					name: (identifier) @function.var
				)
				(expression_list
					value: (function_definition
						parameters: (parameters) @function.params
					)
				)
			) @function.assignment
		`,

		// Imports (require statements)
		imports: `
			(function_call
				name: (identifier) @require.name
				arguments: (arguments
					(string) @require.module
				)
				(#eq? @require.name "require")
			) @require.statement
		`,

		// Exports (return statements with tables)
		exports: `
			(return_statement
				(expression_list
					(table_constructor) @export.table
				)
			) @export.statement
		`,
	},
};

/**
 * Python configuration.
 *
 * Supports: .py
 */
export const PYTHON_CONFIG: LanguageConfig = {
	extensions: ['.py'],
	parserName: 'python',
	queries: {
		// Classes
		classes: `
			(class_definition
				name: (identifier) @class.name
				superclasses: (argument_list)? @class.bases
			) @class.definition
		`,

		// Functions and methods
		functions: `
			(function_definition
				name: (identifier) @function.name
				parameters: (parameters) @function.params
			) @function.definition
		`,

		// Imports
		imports: `
			(import_statement
				name: (dotted_name) @import.module
			) @import.statement

			(import_from_statement
				module_name: (dotted_name) @import.from
				name: (dotted_name) @import.name
			) @import.from.statement

			(import_from_statement
				module_name: (dotted_name) @import.from
				name: (aliased_import
					name: (dotted_name) @import.name
					alias: (identifier) @import.alias
				)
			) @import.from.aliased
		`,

		// Exports (__all__ list)
		exports: `
			(assignment
				left: (identifier) @export.all
				right: (list) @export.list
				(#eq? @export.all "__all__")
			)
		`,
	},
};

/**
 * TypeScript/JavaScript configuration.
 *
 * Supports: .ts, .tsx, .js, .jsx, .mjs
 */
export const TYPESCRIPT_CONFIG: LanguageConfig = {
	extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
	parserName: 'typescript',
	queries: {
		// Classes and interfaces
		classes: `
			(class_declaration
				name: (type_identifier) @class.name
			) @class.definition

			(interface_declaration
				name: (type_identifier) @interface.name
			) @interface.definition

			(type_alias_declaration
				name: (type_identifier) @type.name
			) @type.definition
		`,

		// Functions and methods
		functions: `
			(function_declaration
				name: (identifier) @function.name
				parameters: (formal_parameters) @function.params
			) @function.definition

			(method_definition
				name: (property_identifier) @method.name
				parameters: (formal_parameters) @method.params
			) @method.definition

			(arrow_function
				parameters: (formal_parameters) @arrow.params
			) @arrow.definition

			(variable_declarator
				name: (identifier) @function.var
				value: (arrow_function
					parameters: (formal_parameters) @function.params
				)
			) @function.arrow.assignment
		`,

		// Imports
		imports: `
			(import_statement
				source: (string) @import.source
			) @import.statement

			(import_clause
				(named_imports
					(import_specifier
						name: (identifier) @import.name
					)
				)
			)

			(import_clause
				(identifier) @import.default
			)
		`,

		// Exports
		exports: `
			(export_statement
				declaration: (_) @export.declaration
			) @export.statement

			(export_clause
				(export_specifier
					name: (identifier) @export.name
				)
			)
		`,
	},
};

// =============================================================================
// Language Registry
// =============================================================================

/**
 * Map of language name to configuration.
 * Priority order: C++, C#, Java, Lua, Python, TypeScript
 */
export const LANGUAGE_REGISTRY: Record<string, LanguageConfig> = {
	cpp: CPP_CONFIG,
	'c++': CPP_CONFIG,
	csharp: CSHARP_CONFIG,
	'c#': CSHARP_CONFIG,
	java: JAVA_CONFIG,
	lua: LUA_CONFIG,
	python: PYTHON_CONFIG,
	typescript: TYPESCRIPT_CONFIG,
	javascript: TYPESCRIPT_CONFIG,
	tsx: TYPESCRIPT_CONFIG,
};

/**
 * Map of file extension to language name.
 * Priority order: C++, C#, Java, Lua, Python, TypeScript
 */
export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
	// C++
	'.cpp': 'cpp',
	'.cc': 'cpp',
	'.cxx': 'cpp',
	'.h': 'cpp',
	'.hpp': 'cpp',
	// C#
	'.cs': 'csharp',
	// Java
	'.java': 'java',
	// Lua
	'.lua': 'lua',
	// Python
	'.py': 'python',
	// TypeScript/JavaScript
	'.ts': 'typescript',
	'.tsx': 'tsx',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.mjs': 'javascript',
};

/**
 * Get language configuration for a file extension.
 */
export function getLanguageConfig(extension: string): LanguageConfig | null {
	const language = EXTENSION_TO_LANGUAGE[extension.toLowerCase()];
	if (!language) return null;

	return LANGUAGE_REGISTRY[language] ?? null;
}

/**
 * Check if a file extension is supported.
 */
export function isLanguageSupported(extension: string): boolean {
	return extension.toLowerCase() in EXTENSION_TO_LANGUAGE;
}

/**
 * Get all supported file extensions.
 */
export function getSupportedExtensions(): string[] {
	return Object.keys(EXTENSION_TO_LANGUAGE);
}

/**
 * Get language name from file extension.
 */
export function getLanguageName(extension: string): string | null {
	return EXTENSION_TO_LANGUAGE[extension.toLowerCase()] ?? null;
}

/**
 * Detect if a file is a test file based on naming conventions.
 */
export function isTestFile(filePath: string): boolean {
	const lowerPath = filePath.toLowerCase();

	// Common test patterns across all languages
	const testPatterns = [
		// C++
		/test.*\.(cpp|cc|cxx|h|hpp)$/,
		/_test\.(cpp|cc|cxx|h|hpp)$/,
		/\/tests?\//,
		// C#
		/test.*\.cs$/,
		/\.test\.cs$/,
		/tests\.cs$/,
		// Java
		/test.*\.java$/,
		/.*test\.java$/,
		/\/test\//,
		// Lua
		/test.*\.lua$/,
		/_spec\.lua$/,
		// Python
		/test_.*\.py$/,
		/_test\.py$/,
		/\/tests?\//,
		// TypeScript/JavaScript
		/\.test\.(ts|tsx|js|jsx)$/,
		/\.spec\.(ts|tsx|js|jsx)$/,
		/__tests__\//,
	];

	return testPatterns.some((pattern) => pattern.test(lowerPath));
}

/**
 * Extract test framework from file content (heuristic).
 */
export function detectTestFramework(content: string, language: string): string | null {
	switch (language) {
		case 'cpp':
		case 'c++':
			if (content.includes('#include <gtest/gtest.h>')) return 'gtest';
			if (content.includes('#include <catch2/catch.hpp>')) return 'catch2';
			if (content.includes('#include "doctest.h"')) return 'doctest';
			break;

		case 'csharp':
		case 'c#':
			if (content.includes('using Xunit')) return 'xunit';
			if (content.includes('using NUnit')) return 'nunit';
			if (content.includes('using Microsoft.VisualStudio.TestTools')) return 'mstest';
			break;

		case 'java':
			if (content.includes('import org.junit')) return 'junit';
			if (content.includes('import org.testng')) return 'testng';
			break;

		case 'lua':
			if (content.includes('require("busted")')) return 'busted';
			if (content.includes('require("luaunit")')) return 'luaunit';
			break;

		case 'python':
			if (content.includes('import pytest') || content.includes('from pytest')) return 'pytest';
			if (content.includes('import unittest') || content.includes('from unittest')) return 'unittest';
			break;

		case 'typescript':
		case 'javascript':
			if (content.includes('describe(') || content.includes('it(')) return 'jest';
			if (content.includes('test(') && content.includes('expect(')) return 'vitest';
			if (content.includes('Deno.test')) return 'deno';
			break;
	}

	return null;
}
