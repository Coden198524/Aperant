import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildProjectIndex } from './project-indexer';

let tempDirs: string[] = [];

function makeProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'project-indexer-test-'));
  tempDirs.push(projectDir);
  return projectDir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('project indexer', () => {
  it('keeps a generic root service and source summary for non-package-manager projects', () => {
    const projectDir = makeProject();
    mkdirSync(join(projectDir, 'Source', 'Runtime'), { recursive: true });
    mkdirSync(join(projectDir, 'Tools'), { recursive: true });
    mkdirSync(join(projectDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(projectDir, 'Source', 'Runtime', 'runtime.cpp'), 'int main() { return 0; }\n', 'utf-8');
    writeFileSync(join(projectDir, 'Source', 'Runtime', 'runtime.cs'), 'public class Runtime {}\n', 'utf-8');
    writeFileSync(join(projectDir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n', 'utf-8');
    writeFileSync(join(projectDir, 'App.sln'), '\n', 'utf-8');
    writeFileSync(join(projectDir, '.github', 'workflows', 'build.yml'), 'name: build\n', 'utf-8');

    const index = buildProjectIndex(projectDir);

    expect(index.services.main).toBeDefined();
    expect(index.services.main.language).toContain('C++');
    expect(index.services.main.language).toContain('C#');
    expect(index.source_summary?.source_file_count).toBe(2);
    expect(index.source_summary?.languages).toEqual(expect.arrayContaining(['C++', 'C#']));
    expect(index.source_summary?.build_files).toContain('CMakeLists.txt');
    expect(index.source_summary?.project_files).toContain('App.sln');
    expect(index.infrastructure.ci_workflows).toContain('build.yml');
  });

  it('uses source languages for large mixed-language roots even when package metadata exists', () => {
    const projectDir = makeProject();
    mkdirSync(join(projectDir, 'Source', 'Runtime'), { recursive: true });
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { build: 'node build.js' }, devDependencies: { vite: 'latest' } }),
      'utf-8',
    );

    for (let i = 0; i < 180; i += 1) {
      writeFileSync(join(projectDir, 'Source', 'Runtime', `runtime-${i}.cpp`), 'int main() { return 0; }\n', 'utf-8');
    }
    for (let i = 0; i < 90; i += 1) {
      writeFileSync(join(projectDir, 'Source', 'Runtime', `tool-${i}.cs`), 'public class Tool {}\n', 'utf-8');
    }

    const index = buildProjectIndex(projectDir);

    expect(index.source_summary?.source_file_count).toBe(270);
    expect(index.services.main.language).toContain('C++');
    expect(index.services.main.language).toContain('C#');
    expect(index.services.main.languages).toEqual(expect.arrayContaining(['C++', 'C#']));
    expect(index.services.main.package_manager).toBe('npm');
  });
});
