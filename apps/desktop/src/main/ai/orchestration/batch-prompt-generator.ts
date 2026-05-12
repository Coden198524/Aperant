/**
 * Batch Prompt Generator
 * =======================
 *
 * Generates prompts for batch subtask execution.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchPromptConfig, SubtaskInfo } from './batch-types';

// =============================================================================
// Constants
// =============================================================================

/** Maximum lines to read from pattern files */
const MAX_PATTERN_FILE_LINES = 200;

// =============================================================================
// Prompt Generation
// =============================================================================

/**
 * Generates a batch prompt for multiple subtasks.
 *
 * @param config - Batch prompt configuration
 * @returns Generated prompt string
 */
export async function generateBatchPrompt(config: BatchPromptConfig): Promise<string> {
  const { subtasks, specDir, projectDir, attemptCount, isContinuation, previousProgress } = config;

  const sections: string[] = [];

  // 1. Environment context
  sections.push(generateEnvironmentContext(projectDir, specDir));

  // 2. Continuation context (if applicable)
  if (isContinuation && previousProgress) {
    sections.push(generateContinuationContext(previousProgress));
  }

  // 3. Task manifest
  sections.push(generateTaskManifest(subtasks));

  // 4. Batch execution instructions
  sections.push(generateBatchInstructions(subtasks.length, attemptCount));

  // 5. Pattern files (merged and deduplicated)
  const patternFilesSection = await loadPatternFiles(subtasks, projectDir);
  if (patternFilesSection) {
    sections.push(patternFilesSection);
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Generates environment context section.
 *
 * @param projectDir - Project directory
 * @param specDir - Spec directory
 * @returns Environment context string
 */
function generateEnvironmentContext(projectDir: string, specDir: string): string {
  return `# 环境信息

**工作目录**: ${projectDir}
**规范目录**: ${specDir}

你将在项目目录中工作，实现规范中定义的子任务。`;
}

/**
 * Generates continuation context section.
 *
 * @param previousProgress - Previous progress information
 * @returns Continuation context string
 */
function generateContinuationContext(previousProgress: {
  completed: string[];
  inProgress: string[];
  blocked: string[];
  notStarted: string[];
}): string {
  return `# 续接会话

这是一个续接会话。之前的会话因上下文窗口耗尽而中断。

**已完成**: ${previousProgress.completed.length} 个子任务
**进行中**: ${previousProgress.inProgress.length} 个子任务
**被阻塞**: ${previousProgress.blocked.length} 个子任务
**未开始**: ${previousProgress.notStarted.length} 个子任务

请继续完成剩余的子任务。`;
}

/**
 * Generates task manifest section.
 *
 * @param subtasks - Array of subtasks
 * @returns Task manifest string
 */
function generateTaskManifest(subtasks: SubtaskInfo[]): string {
  const manifest = subtasks
    .map((st, i) => {
      const fileOps: string[] = [];
      if (st.filesToCreate && st.filesToCreate.length > 0) {
        fileOps.push(`- 创建: ${st.filesToCreate.join(', ')}`);
      }
      if (st.filesToModify && st.filesToModify.length > 0) {
        fileOps.push(`- 修改: ${st.filesToModify.join(', ')}`);
      }

      return `### 子任务 ${i + 1}/${subtasks.length}: ${st.id}

**描述**: ${st.description}

${fileOps.length > 0 ? `**文件操作**:\n${fileOps.join('\n')}` : ''}

${st.verification ? `**验证**: ${st.verification}` : ''}`;
    })
    .join('\n\n');

  return `## 任务清单

你需要按顺序完成以下 ${subtasks.length} 个子任务：

${manifest}`;
}

/**
 * Generates batch execution instructions.
 *
 * @param count - Number of subtasks
 * @param attempt - Attempt count
 * @returns Batch instructions string
 */
function generateBatchInstructions(count: number, attempt: number): string {
  const retryContext =
    attempt > 0
      ? `
### ⚠️ 重试提示
这是第 ${attempt + 1} 次尝试。之前的批量执行未完全成功。
请特别注意之前可能失败的子任务。
`
      : '';

  return `## 执行协议

你将在单个会话中完成 ${count} 个子任务。请遵循以下协议：

### 1. 执行顺序
- 严格按照上述顺序（1 → ${count}）完成子任务
- 不要跳过任何子任务
- 如果某个子任务被阻塞，在 implementation_plan.json 中标记为 "blocked" 并继续下一个

### 2. 进度跟踪
完成每个子任务后，你必须：
1. 更新 implementation_plan.json，将该子任务的 status 设为 "completed"，并添加 completion_summary。必须使用 Markdown 审核矩阵：| Item | Details |、| --- | --- |、| What changed | ... |、| Verification | ... |、| Review notes | ... |
2. 在输出中添加进度标记：\`[SUBTASK_COMPLETED: {id}]\`
3. 提交代码（每 2-3 个子任务提交一次）

### 3. 验证要求
- 每个子任务完成后必须运行验证
- 验证失败时必须修复后再继续
- 不要跳过验证步骤

### 4. 质量标准
- 遵循模式文件中的代码风格
- 无 console.log 或调试语句
- 适当的错误处理
- 保持代码整洁
${retryContext}
## 开始执行

现在开始执行这 ${count} 个子任务。记住：按顺序、验证、更新状态、提交代码。`;
}

/**
 * Loads and merges pattern files from all subtasks.
 *
 * @param subtasks - Array of subtasks
 * @param projectDir - Project directory
 * @returns Pattern files section string, or null if no pattern files
 */
async function loadPatternFiles(
  subtasks: SubtaskInfo[],
  projectDir: string
): Promise<string | null> {
  // Collect unique pattern files
  const patternFiles = new Set<string>();
  for (const subtask of subtasks) {
    if (subtask.patternFiles) {
      for (const file of subtask.patternFiles) {
        patternFiles.add(file);
      }
    }
  }

  if (patternFiles.size === 0) {
    return null;
  }

  // Load pattern files
  const loadedFiles: Array<{ path: string; content: string }> = [];

  for (const file of patternFiles) {
    try {
      const filePath = join(projectDir, file);
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // Truncate if too long
      const truncated =
        lines.length > MAX_PATTERN_FILE_LINES
          ? lines.slice(0, MAX_PATTERN_FILE_LINES).join('\n') +
            `\n\n... (truncated, ${lines.length - MAX_PATTERN_FILE_LINES} more lines)`
          : content;

      loadedFiles.push({ path: file, content: truncated });
    } catch (error) {
      console.warn(`[BatchPromptGenerator] Failed to load pattern file ${file}:`, error);
    }
  }

  if (loadedFiles.length === 0) {
    return null;
  }

  // Format pattern files section
  const filesSection = loadedFiles
    .map(
      (f) => `### ${f.path}

\`\`\`
${f.content}
\`\`\``
    )
    .join('\n\n');

  return `## 模式文件

以下是相关的模式文件，请遵循其中的代码风格和模式：

${filesSection}`;
}

/**
 * Collects unique pattern files from all subtasks.
 *
 * @param subtasks - Array of subtasks
 * @returns Array of unique pattern file paths
 */
export function collectUniquePatterns(subtasks: SubtaskInfo[]): string[] {
  const patterns = new Set<string>();

  for (const subtask of subtasks) {
    if (subtask.patternFiles) {
      for (const file of subtask.patternFiles) {
        patterns.add(file);
      }
    }
  }

  return Array.from(patterns);
}
