import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InsightsDocumentCapabilityManager } from './document-capabilities';

const temporaryDirectories: string[] = [];

function createFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aperant-insights-capability-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'selected.md');
  fs.writeFileSync(filePath, '# selected\n');
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('InsightsDocumentCapabilityManager', () => {
  it('accepts a valid token exactly once for its project, sender, and path', () => {
    const manager = new InsightsDocumentCapabilityManager({ tokenFactory: () => 'opaque-token' });
    const filePath = createFile();
    const authorization = manager.issue('project-1', 7, filePath);

    expect(manager.validateAndConsume({
      authorizationToken: authorization.authorizationToken,
      projectId: 'project-1',
      senderId: 7,
      path: fs.realpathSync(filePath),
    })).toBe(true);
    expect(manager.validateAndConsume({
      authorizationToken: authorization.authorizationToken,
      projectId: 'project-1',
      senderId: 7,
      path: fs.realpathSync(filePath),
    })).toBe(false);
  });

  it('rejects cross-project, cross-sender, and path substitution attempts', () => {
    const manager = new InsightsDocumentCapabilityManager();
    const filePath = createFile();
    const otherPath = path.join(path.dirname(filePath), 'other.md');
    fs.writeFileSync(otherPath, '# other\n');

    const crossProject = manager.issue('project-1', 7, filePath);
    expect(manager.validateAndConsume({
      authorizationToken: crossProject.authorizationToken,
      projectId: 'project-2',
      senderId: 7,
      path: fs.realpathSync(filePath),
    })).toBe(false);

    const crossSender = manager.issue('project-1', 7, filePath);
    expect(manager.validateAndConsume({
      authorizationToken: crossSender.authorizationToken,
      projectId: 'project-1',
      senderId: 8,
      path: fs.realpathSync(filePath),
    })).toBe(false);

    const substitutedPath = manager.issue('project-1', 7, filePath);
    expect(manager.validateAndConsume({
      authorizationToken: substitutedPath.authorizationToken,
      projectId: 'project-1',
      senderId: 7,
      path: fs.realpathSync(otherPath),
    })).toBe(false);
  });

  it('rejects a case-only path substitution on case-sensitive Windows filesystems', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const manager = new InsightsDocumentCapabilityManager({
        tokenFactory: () => 'case-sensitive-token',
      });
      const filePath = createFile();
      const authorization = manager.issue('project-1', 7, filePath);
      const canonicalPath = fs.realpathSync(filePath);
      const substitutedPath = path.join(
        path.dirname(canonicalPath),
        path.basename(canonicalPath).toUpperCase(),
      );

      expect(substitutedPath).not.toBe(canonicalPath);
      expect(manager.validateAndConsume({
        authorizationToken: authorization.authorizationToken,
        projectId: 'project-1',
        senderId: 7,
        path: substitutedPath,
      })).toBe(false);
      expect(manager.validateAndConsume({
        authorizationToken: authorization.authorizationToken,
        projectId: 'project-1',
        senderId: 7,
        path: canonicalPath,
      })).toBe(true);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('rejects expired tokens', () => {
    let now = 1_000;
    const manager = new InsightsDocumentCapabilityManager({
      ttlMs: 50,
      now: () => now,
    });
    const filePath = createFile();
    const authorization = manager.issue('project-1', 7, filePath);
    now += 51;

    expect(manager.validateAndConsume({
      authorizationToken: authorization.authorizationToken,
      projectId: 'project-1',
      senderId: 7,
      path: fs.realpathSync(filePath),
    })).toBe(false);
  });

  it('rejects missing files and directories at issuance', () => {
    const manager = new InsightsDocumentCapabilityManager();
    const filePath = createFile();

    expect(() => manager.issue('project-1', 7, path.dirname(filePath))).toThrow(
      'not a regular file',
    );
    expect(() => manager.issue('project-1', 7, `${filePath}.missing`)).toThrow(
      'unavailable',
    );
  });
});
