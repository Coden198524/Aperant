import type { Plugin } from 'vite';

/**
 * Vite plugin to fix Electron ESM named export issues
 * Converts: import electron, { app, BrowserWindow } from "electron"
 * To: import electron from "electron"; const { app, BrowserWindow } = electron;
 * Also removes: import * as electron from "electron" (namespace imports)
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

          // Remove namespace imports: import * as electron from "electron"
          chunk.code = chunk.code.replace(/import\s+\*\s+as\s+\w+\s+from\s+["']electron["'];?\n?/g, () => {
            modified = true;
            return '';
          });

          // Match: import electron__default, { named, exports } from "electron"
          const electronImportRegex = /import\s+(\w+)(?:,\s*\{([^}]+)\})?\s+from\s+["']electron["'];?/g;

          chunk.code = chunk.code.replace(electronImportRegex, (match, defaultImport, namedImports) => {
            if (!namedImports) {
              // Only default import, no change needed
              return match;
            }

            modified = true;
            // Split into default import + destructuring
            const destructure = `const {${namedImports}} = ${defaultImport};`;
            return `import ${defaultImport} from "electron";\n${destructure}`;
          });

          if (modified) {
            console.log(`[electron-esm-fix] Fixed Electron imports in ${fileName}`);
          }
        }
      }
    }
  };
}
