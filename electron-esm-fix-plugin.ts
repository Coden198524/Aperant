import type { Plugin } from 'vite';

/**
 * Vite plugin to fix Electron ESM named export issues
 * Converts: import electron__default, { app, BrowserWindow } from "electron"
 * To: import electron__default from "electron"; const { app, BrowserWindow } = electron__default;
 */
export function electronEsmFixPlugin(): Plugin {
  return {
    name: 'electron-esm-fix',
    apply: 'build',
    enforce: 'post',
    generateBundle(options, bundle) {
      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk.type === 'chunk' && fileName.endsWith('.js')) {
          let modified = false;
          let defaultImportName = 'electron__default';

          // Remove namespace imports: import * as electron from "electron"
          chunk.code = chunk.code.replace(/import\s+\*\s+as\s+\w+\s+from\s+["']electron["'];?\n?/g, () => {
            modified = true;
            return '';
          });

          // Match: import electron__default, { named, exports } from "electron"
          // Capture the default import name and all named imports
          const electronImportRegex = /import\s+(\w+),\s*\{([^}]+)\}\s+from\s+["']electron["'];?/g;

          chunk.code = chunk.code.replace(electronImportRegex, (match, defaultImport, namedImports) => {
            modified = true;
            defaultImportName = defaultImport;
            // Convert TypeScript 'as' syntax to JavaScript ':' syntax in destructuring
            // e.g., "app as app$8" -> "app: app$8"
            const jsNamedImports = namedImports.trim().replace(/\s+as\s+/g, ': ');
            const destructure = `const { ${jsNamedImports} } = ${defaultImport};`;
            return `import ${defaultImport} from "electron";\n${destructure}`;
          });

          // Replace bare 'electron.' references with the actual default import name
          // This handles cases where code uses electron.utilityProcess, etc.
          chunk.code = chunk.code.replace(/\belectron\./g, `${defaultImportName}.`);

          if (modified) {
            console.log(`[electron-esm-fix] Fixed Electron imports in ${fileName}`);
          }
        }
      }
    }
  };
}
