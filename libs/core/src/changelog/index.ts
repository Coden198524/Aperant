export type AutocodeChangelogFormat = 'keep-a-changelog' | 'simple-list' | 'github-release';
export type AutocodeChangelogAudience = 'technical' | 'user-facing' | 'marketing';
export type AutocodeChangelogEmojiLevel = 'none' | 'little' | 'medium' | 'high';
export type AutocodeChangelogSourceMode = 'tasks' | 'git-history' | 'branch-diff';
export type AutocodeVersionBumpType = 'major' | 'minor' | 'patch';

export interface AutocodeTaskSpecContent {
  taskId: string;
  specId: string;
  spec?: string;
  requirements?: Record<string, unknown>;
  qaReport?: string;
  implementationPlan?: {
    workflow_type?: string;
    workflowType?: string;
  };
  error?: string;
}

export interface AutocodeGitHistoryOptions {
  type: 'recent' | 'since-date' | 'tag-range' | 'since-version';
  count?: number;
  sinceDate?: string;
  fromTag?: string;
  toTag?: string;
  includeMergeCommits?: boolean;
}

export interface AutocodeBranchDiffOptions {
  baseBranch: string;
  compareBranch: string;
}

export interface AutocodeGitCommit {
  hash: string;
  fullHash: string;
  subject: string;
  body?: string;
  author: string;
  authorEmail: string;
  date: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

export interface AutocodeChangelogGenerationRequest {
  projectId: string;
  sourceMode: AutocodeChangelogSourceMode;
  taskIds?: string[];
  gitHistory?: AutocodeGitHistoryOptions;
  branchDiff?: AutocodeBranchDiffOptions;
  version: string;
  date: string;
  format: AutocodeChangelogFormat;
  audience: AutocodeChangelogAudience;
  emojiLevel?: AutocodeChangelogEmojiLevel;
  customInstructions?: string;
}

export interface AutocodeExistingChangelog {
  exists: boolean;
  content?: string;
  lastVersion?: string;
  error?: string;
}

export interface AutocodeVersionSuggestion {
  version: string;
  reason: string;
  bumpType: AutocodeVersionBumpType;
}

export function extractAutocodeSpecOverview(spec: string): string {
  const lines = spec.split(/\r?\n/);
  let inOverview = false;
  const overview: string[] = [];

  for (const line of lines) {
    if (/^##\s*Overview/i.test(line)) {
      inOverview = true;
      continue;
    }
    if (inOverview && /^##\s/.test(line)) {
      break;
    }
    if (inOverview && line.trim()) {
      overview.push(line);
    }
  }

  if (overview.length === 0) {
    const paragraphs = spec.split(/\n\n+/).filter((paragraph) => !paragraph.startsWith('#') && paragraph.trim().length > 20);
    if (paragraphs.length > 0) {
      return paragraphs[0].substring(0, 300);
    }
  }

  return overview.join(' ').substring(0, 400);
}

export function extractAutocodeChangelog(output: string): string {
  let changelog = output.trim();
  const changelogStartPatterns = [
    /^(##\s*\[[\d.]+\])/m,
    /^(##\s*What['']?s\s+New)/im,
    /^(#\s*Release\s+v?[\d.]+)/im,
    /^(#\s*Changelog)/im,
    /^(##\s*v?[\d.]+)/m,
  ];

  for (const pattern of changelogStartPatterns) {
    const match = changelog.match(pattern);
    if (match && match.index !== undefined) {
      changelog = changelog.substring(match.index);
      break;
    }
  }

  const prefixes = [
    /^I['']ll\s+analyze[^#]*(?=#)/is,
    /^I['']ll\s+generate[^#]*(?=#)/is,
    /^Here['']s the changelog[:\s]*/i,
    /^The changelog[:\s]*/i,
    /^Changelog[:\s]*/i,
    /^Based on[^#]*(?=#)/is,
    /^Let me[^#]*(?=#)/is,
  ];

  for (const prefix of prefixes) {
    changelog = changelog.replace(prefix, '');
  }

  return changelog.trim();
}

export function parseAutocodeExistingChangelogContent(content: string): AutocodeExistingChangelog {
  const versionPatterns = [
    /##\s*\[(\d+\.\d+\.\d+)\]/,
    /v(\d+\.\d+\.\d+)/,
    /Version\s+(\d+\.\d+\.\d+)/i,
  ];

  let lastVersion: string | undefined;
  for (const pattern of versionPatterns) {
    const match = content.match(pattern);
    if (match) {
      lastVersion = match[1];
      break;
    }
  }

  return {
    exists: true,
    content,
    lastVersion,
  };
}

export function parseAutocodeExistingChangelogError(error: unknown): AutocodeExistingChangelog {
  return {
    exists: true,
    error: error instanceof Error ? error.message : 'Failed to read changelog',
  };
}

export function parseAutocodeGitLogOutput(output: string): AutocodeGitCommit[] {
  const commits: AutocodeGitCommit[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('|');
    if (parts.length < 6) continue;

    const [hash, fullHash, subject, author, authorEmail, date] = parts;
    commits.push({
      hash,
      fullHash,
      subject,
      body: undefined,
      author,
      authorEmail,
      date,
    });
  }

  return commits;
}

const FORMAT_TEMPLATES: Record<AutocodeChangelogFormat, (version: string, date: string) => string> = {
  'keep-a-changelog': (version, date) => `## [${version}] - ${date}

### Added
- [New features]

### Changed
- [Modifications]

### Fixed
- [Bug fixes]`,

  'simple-list': (version, date) => `# Release v${version} (${date})

**New Features:**
- [List features]

**Improvements:**
- [List improvements]

**Bug Fixes:**
- [List fixes]`,

  'github-release': (version, date) => `## ${version} - ${date}

### New Features

- Feature description

### Improvements

- Improvement description

### Bug Fixes

- Fix description

---

## What's Changed

- type: description by @contributor in commit-hash

## Thanks to all contributors

@contributor1, @contributor2`,
};

const AUDIENCE_INSTRUCTIONS: Record<AutocodeChangelogAudience, string> = {
  technical: 'Write a developer changelog with precise technical language.',
  'user-facing': 'Write user-facing release notes focused on benefits.',
  marketing: 'Write release notes focused on outcomes and user impact.',
};

export function getAutocodeChangelogEmojiInstructions(
  emojiLevel?: string,
  format?: string,
): string {
  if (!emojiLevel || emojiLevel === 'none') {
    return '';
  }

  if (format === 'github-release') {
    const githubInstructions: Record<string, string> = {
      little: `Add emojis to section headings only. Use these emoji-heading pairs:
- "### ✨ New Features"
- "### 🛠️ Improvements"
- "### 🐛 Bug Fixes"
- "### 📚 Documentation"
- "### 🔧 Other Changes"
Do not add emojis to individual line items.`,
      medium: `Add emojis to section headings and notable items only.
Use these emoji-heading pairs:
- "### ✨ New Features"
- "### 🛠️ Improvements"
- "### 🐛 Bug Fixes"
- "### 📚 Documentation"
- "### 🔧 Other Changes"
Add emojis to 2-3 highlighted items per section that are particularly significant.`,
      high: `Add emojis to section headings and every line item.
Use these emoji-heading pairs:
- "### ✨ New Features"
- "### 🛠️ Improvements"
- "### 🐛 Bug Fixes"
- "### 📚 Documentation"
- "### 🔧 Other Changes"
Every line item should start with a contextual emoji.`,
    };
    return githubInstructions[emojiLevel] || '';
  }

  const instructions: Record<string, string> = {
    little: `Add emojis to section headings only. Each heading should have one contextual emoji at the start.
Examples:
- "### ✨ New Features" or "### 🚀 New Features"
- "### 🐛 Bug Fixes"
- "### 🔧 Improvements" or "### ⚡ Improvements"
- "### 📚 Documentation"
Do not add emojis to individual line items.`,
    medium: `Add emojis to section headings and notable items only.
Section headings should have one emoji (e.g., "### ✨ New Features", "### 🐛 Bug Fixes").
Add emojis to 2-3 highlighted items per section that are particularly significant.
Examples of highlighted items:
- "- 🎉 **Major Feature**: Description"
- "- 🔒 **Security Fix**: Description"
Most regular line items should NOT have emojis.`,
    high: `Add emojis to section headings AND every line item for maximum visual appeal.
Section headings: "### ✨ New Features", "### 🐛 Bug Fixes", "### ⚡ Improvements"
Every line item should start with a contextual emoji:
- "- ✨ Added new feature..."
- "- 🐛 Fixed bug where..."
- "- 🔧 Improved performance of..."
- "- 📝 Updated documentation for..."
- "- 🎨 Refined UI styling..."
Use diverse, contextually appropriate emojis for each item.`,
  };

  return instructions[emojiLevel] || '';
}

export function buildAutocodeChangelogPrompt(
  request: AutocodeChangelogGenerationRequest,
  specs: AutocodeTaskSpecContent[],
): string {
  const audienceInstruction = AUDIENCE_INSTRUCTIONS[request.audience];
  const formatInstruction = FORMAT_TEMPLATES[request.format](request.version, request.date);
  const emojiInstruction = getAutocodeChangelogEmojiInstructions(request.emojiLevel, request.format);
  const taskSummaries = specs.map((spec) => {
    const parts: string[] = [`- **${spec.specId}**`];
    const workflowType = spec.implementationPlan?.workflow_type || spec.implementationPlan?.workflowType;

    if (typeof workflowType === 'string') {
      parts.push(`(${workflowType})`);
    }

    if (spec.spec) {
      const overview = extractAutocodeSpecOverview(spec.spec);
      if (overview) {
        parts.push(`: ${overview}`);
      }
    }

    return parts.join('');
  }).join('\n');

  let formatSpecificInstructions = '';
  if (request.format === 'github-release') {
    formatSpecificInstructions = `
For GitHub Release format:

Release title:
- Create a concise 2-5 word theme from the completed tasks.
- Version header: "## ${request.version} - [Your Thematic Title]"
- Focus on user benefit or functional area, not implementation details.
`;
  }

  return `${audienceInstruction}

Format:
${formatInstruction}
${emojiInstruction ? `\nEmoji Usage:\n${emojiInstruction}` : ''}
${formatSpecificInstructions}

Completed tasks:
${taskSummaries}

${request.customInstructions ? `Note: ${request.customInstructions}` : ''}

Output only raw changelog content. Start with the changelog heading; no preamble, analysis, questions, or clarifications.`;
}

export function buildAutocodeGitChangelogPrompt(
  request: AutocodeChangelogGenerationRequest,
  commits: AutocodeGitCommit[],
): string {
  const audienceInstruction = AUDIENCE_INSTRUCTIONS[request.audience];
  const formatInstruction = FORMAT_TEMPLATES[request.format](request.version, request.date);
  const emojiInstruction = getAutocodeChangelogEmojiInstructions(request.emojiLevel, request.format);
  const commitLines = commits.map((commit) => {
    const conventionalMatch = commit.subject.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
    if (conventionalMatch) {
      const [, type, scope, message] = conventionalMatch;
      return `- ${commit.hash} | ${type}${scope ? `(${scope})` : ''}: ${message} | by ${commit.author}`;
    }
    return `- ${commit.hash} | ${commit.subject} | by ${commit.author}`;
  }).join('\n');

  let sourceContext = '';
  if (request.branchDiff) {
    sourceContext = `These commits are from branch "${request.branchDiff.compareBranch}" that are not in "${request.branchDiff.baseBranch}".`;
  } else if (request.gitHistory) {
    switch (request.gitHistory.type) {
      case 'recent':
        sourceContext = `These are the ${commits.length} most recent commits.`;
        break;
      case 'since-date':
        sourceContext = `These are commits since ${request.gitHistory.sinceDate}.`;
        break;
      case 'tag-range':
        sourceContext = `These are commits between tag "${request.gitHistory.fromTag}" and "${request.gitHistory.toTag || 'HEAD'}".`;
        break;
    }
  }

  let formatSpecificInstructions = '';
  if (request.format === 'github-release') {
    formatSpecificInstructions = `
For GitHub Release format:

Release title:
- Create a concise 2-5 word theme from the commits.
- Version header: "## ${request.version} - [Your Thematic Title]"
- Focus on user benefit or functional area, not implementation details.

PART 1 - Categorized changes (summarized):
- Use category sections: New Features, Improvements, Bug Fixes, Documentation, Other Changes
- Include only sections with actual changes.
- Add a blank line between each bullet point for cleaner formatting
- Summarize and group related commits into clear, readable descriptions
- Do not include commit hashes in this section.

PART 2 - "What's Changed" (raw commit list):
- Add a horizontal rule (---) before this section
- List each commit in format: "- type: description by @author in hash"
- Example: "- fix: upgrade react to 19.2.3 by @douxc in abc1234"
- Example: "- feat: add dark mode support by @contributor in def5678"
- Include the commit type prefix (feat:, fix:, docs:, etc.)
- Show the author name with @ prefix
- Show the short commit hash at the end

PART 3 - "Thanks to all contributors" (deduplicated list):
- Add this section after "What's Changed"
- Extract all unique contributor names from the commits
- List them in a comma-separated format with @ prefix
- Example: "## Thanks to all contributors\\n\\n@contributor1, @contributor2, @contributor3"
- Only include unique names (no duplicates)
- This acknowledges everyone who contributed to this release`;
  }

  return `${audienceInstruction}

${sourceContext}

Generate a changelog from these git commits. Group related changes together and categorize them appropriately.

Conventional commit types to recognize:
- feat/feature: New features → New Features section
- fix/bugfix: Bug fixes → Bug Fixes section
- docs: Documentation → Documentation section
- style/refactor/perf: Improvements → Improvements section
- chore/build/ci: Other changes → Other Changes section (usually omit unless significant)
- test: Tests → (usually omit unless significant)
${formatSpecificInstructions}

Format:
${formatInstruction}
${emojiInstruction ? `\nEmoji Usage:\n${emojiInstruction}` : ''}

Git commits (${commits.length} total):
${commitLines}

${request.customInstructions ? `Note: ${request.customInstructions}` : ''}

Output only raw changelog content. Start with the changelog heading; no preamble, analysis, questions, or clarifications. Group related commits and include only sections with actual changes.`;
}

export function buildAutocodeVersionBumpPrompt(
  commits: AutocodeGitCommit[],
  currentVersion: string,
): string {
  const commitSummary = commits
    .map((commit, index) => `${index + 1}. ${commit.hash} - ${commit.subject}`)
    .join('\n');

  return `Suggest a semantic version bump from these commits.

Current version: ${currentVersion}

Commits (${commits.length}):

${commitSummary}

Rules:
- MAJOR (X.0.0): Breaking changes, API changes, removed features, architectural changes
- MINOR (0.X.0): New features, enhancements, additions that maintain backward compatibility
- PATCH (0.0.X): Bug fixes, small tweaks, documentation updates, refactoring without new features

Return only this JSON object:
{
  "bumpType": "major|minor|patch",
  "reason": "Brief explanation of the decision"
}`;
}

export function parseAutocodeVersionSuggestionResponse(
  output: string,
  currentVersion: string,
): AutocodeVersionSuggestion {
  const jsonMatch = output.match(/\{[\s\S]*"bumpType"[\s\S]*"reason"[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in AI response');
  }

  const parsed = JSON.parse(jsonMatch[0]) as { bumpType?: AutocodeVersionBumpType; reason?: string };
  const bumpType = parsed.bumpType || 'patch';
  return {
    version: incrementAutocodeVersion(currentVersion, bumpType),
    reason: parsed.reason || 'AI analysis of commits',
    bumpType,
  };
}

export function fallbackAutocodeVersionSuggestion(currentVersion: string): AutocodeVersionSuggestion {
  return {
    version: incrementAutocodeVersion(currentVersion, 'patch'),
    reason: 'Patch version bump (default)',
    bumpType: 'patch',
  };
}

export function incrementAutocodeVersion(
  currentVersion: string,
  bumpType: AutocodeVersionBumpType,
): string {
  const [major = 0, minor = 0, patch = 0] = currentVersion.split('.').map(Number);

  switch (bumpType) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

export {
  buildAutocodeGitChangelogPrompt as buildGitPrompt,
  buildAutocodeChangelogPrompt as buildChangelogPrompt,
  extractAutocodeChangelog as extractChangelog,
  extractAutocodeSpecOverview as extractSpecOverview,
  parseAutocodeGitLogOutput as parseGitLogOutput,
};
