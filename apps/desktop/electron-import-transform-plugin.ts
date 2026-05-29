import type { Plugin } from 'vite';

/**
 * Vite plugin to transform all electron named imports to default imports.
 *
 * This is necessary because Electron in ESM mode only provides a default export,
 * but Vite's externalizeDepsPlugin analyzes import statements and generates
 * named exports in the bundle, causing runtime errors.
 *
 * Example transformation:
 *   import { app, BrowserWindow } from 'electron';
 *   // becomes:
 *   import electron from 'electron';
 *   const { app, BrowserWindow } = electron;
 *
 *   import { app as electronApp } from 'electron';
 *   // becomes:
 *   import electron from 'electron';
 *   const { app: electronApp } = electron;
 */
export function electronImportTransformPlugin(): Plugin {
  return {
    name: 'electron-import-transform',
    enforce: 'pre', // Run before other plugins
    transform(code, id) {
      // Only process TypeScript/JavaScript files in main process
      if (!id.includes('src/main') || !id.match(/\.(ts|js)$/)) {
        return null;
      }

      // Skip type-only imports
      if (code.includes("import type") && code.includes("from 'electron'")) {
        return null;
      }

      // Match: import { ... } from 'electron';
      const namedImportRegex = /import\s*\{([^}]+)\}\s*from\s*['"]electron['"]\s*;/g;

      let transformed = code;
      let hasTransform = false;

      transformed = transformed.replace(namedImportRegex, (match, imports) => {
        hasTransform = true;
        const cleanImports = formatElectronDestructureImports(imports);
        console.log(`[electron-import-transform] Transforming ${id}`);
        return `import electron from 'electron';\nconst { ${cleanImports} } = electron;`;
      });

      return hasTransform ? { code: transformed, map: null } : null;
    }
  };
}

function formatElectronDestructureImports(imports: string): string {
  return imports
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\s+as\s+/u, ': '))
    .join(', ');
}
