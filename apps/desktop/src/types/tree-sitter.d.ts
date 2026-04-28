/**
 * Type declarations for tree-sitter modules (optional dependencies)
 * These modules are dynamically imported and may not be installed
 */

declare module 'tree-sitter' {
	const Parser: any;
	export default Parser;
}

declare module 'tree-sitter-cpp' {
	const language: any;
	export default language;
}

declare module 'tree-sitter-c-sharp' {
	const language: any;
	export default language;
}

declare module 'tree-sitter-java' {
	const language: any;
	export default language;
}

declare module 'tree-sitter-lua' {
	const language: any;
	export default language;
}

declare module 'tree-sitter-python' {
	const language: any;
	export default language;
}

declare module 'tree-sitter-typescript' {
	export const typescript: any;
	export const tsx: any;
}
