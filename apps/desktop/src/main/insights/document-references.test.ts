import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_INSIGHTS_DOCUMENT_REFERENCES } from '../../shared/constants';
import { normalizeInsightsDocumentReferences } from './document-references';
import { InsightsDocumentCapabilityManager } from './document-capabilities';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aperant-insights-reference-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Insights document reference normalization', () => {
  it('resolves an existing file and derives authoritative metadata from disk', () => {
    const projectPath = createTemporaryDirectory();
    const filePath = path.join(projectPath, 'large notes.md');
    fs.writeFileSync(filePath, 'reference only');

    const references = normalizeInsightsDocumentReferences([{
      id: 'notes-1',
      filename: 'spoofed.exe',
      path: filePath,
      size: 1,
      content: 'must be ignored',
    }], projectPath);

    expect(references).toEqual([{
      id: 'notes-1',
      filename: 'large notes.md',
      path: fs.realpathSync(filePath),
      size: Buffer.byteLength('reference only'),
    }]);
  });

  it('rejects missing files, directories, and duplicate paths', () => {
    const projectPath = createTemporaryDirectory();
    const filePath = path.join(projectPath, 'notes.txt');
    fs.writeFileSync(filePath, 'notes');

    const references = normalizeInsightsDocumentReferences([
      { path: filePath },
      { path: filePath },
      { path: projectPath },
      { path: path.join(projectPath, 'missing.txt') },
    ], projectPath);

    expect(references).toHaveLength(1);
    expect(references[0].path).toBe(fs.realpathSync(filePath));
  });

  it('accepts an explicitly selected file outside the project root with a valid capability', () => {
    const projectPath = createTemporaryDirectory();
    const externalDirectory = createTemporaryDirectory();
    const externalPath = path.join(externalDirectory, 'external.log');
    fs.writeFileSync(externalPath, 'external evidence');
    const capabilities = new InsightsDocumentCapabilityManager();
    const authorization = capabilities.issue('project-1', 41, externalPath);

    const references = normalizeInsightsDocumentReferences([{
      path: externalPath,
      authorizationToken: authorization.authorizationToken,
    }], projectPath, {
      projectId: 'project-1',
      senderId: 41,
      capabilities,
    });

    expect(references).toHaveLength(1);
    expect(references[0].path).toBe(fs.realpathSync(externalPath));
    expect(references[0]).not.toHaveProperty('authorizationToken');
  });

  it('rejects a forged external path without a user-selection capability', () => {
    const projectPath = createTemporaryDirectory();
    const externalDirectory = createTemporaryDirectory();
    const externalPath = path.join(externalDirectory, 'sensitive.txt');
    fs.writeFileSync(externalPath, 'sensitive');

    expect(normalizeInsightsDocumentReferences([{
      path: externalPath,
    }], projectPath)).toEqual([]);
  });

  it('does not consume a valid token when another reference makes the batch invalid', () => {
    const projectPath = createTemporaryDirectory();
    const externalDirectory = createTemporaryDirectory();
    const externalPath = path.join(externalDirectory, 'selected.txt');
    fs.writeFileSync(externalPath, 'selected');
    const capabilities = new InsightsDocumentCapabilityManager();
    const authorization = capabilities.issue('project-1', 41, externalPath);
    const context = { projectId: 'project-1', senderId: 41, capabilities };

    normalizeInsightsDocumentReferences([{
      id: 'valid',
      path: externalPath,
      authorizationToken: authorization.authorizationToken,
    }, {
      id: 'invalid',
      path: path.join(externalDirectory, 'missing.txt'),
    }], projectPath, context);

    const retried = normalizeInsightsDocumentReferences([{
      id: 'valid',
      path: externalPath,
      authorizationToken: authorization.authorizationToken,
    }], projectPath, context);
    expect(retried).toHaveLength(1);
  });

  it('caps reference count without imposing a file-size limit', () => {
    const projectPath = createTemporaryDirectory();
    const payloads = Array.from({ length: MAX_INSIGHTS_DOCUMENT_REFERENCES + 2 }, (_, index) => {
      const filePath = path.join(projectPath, `document-${index}.txt`);
      fs.writeFileSync(filePath, String(index));
      if (index === 0) fs.truncateSync(filePath, 8 * 1024 * 1024);
      return { path: filePath };
    });

    const references = normalizeInsightsDocumentReferences(payloads, projectPath);
    expect(references).toHaveLength(MAX_INSIGHTS_DOCUMENT_REFERENCES);
    expect(references[0].size).toBe(8 * 1024 * 1024);
  });

  it('rejects the whole batch when authoritative resolved paths exceed the aggregate budget', () => {
    const projectPath = createTemporaryDirectory();
    const firstPath = path.join(projectPath, 'first.txt');
    const secondPath = path.join(projectPath, 'second.txt');
    fs.writeFileSync(firstPath, 'first');
    fs.writeFileSync(secondPath, 'second');

    const references = normalizeInsightsDocumentReferences(
      [{ path: firstPath }, { path: secondPath }],
      projectPath,
      undefined,
      MAX_INSIGHTS_DOCUMENT_REFERENCES,
      fs.realpathSync(firstPath).length,
    );

    expect(references).toEqual([]);
  });
});
