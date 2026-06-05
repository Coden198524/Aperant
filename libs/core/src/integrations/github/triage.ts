/** Issue triage categories. */
export const TriageCategory = {
  BUG: 'bug',
  FEATURE: 'feature',
  DOCUMENTATION: 'documentation',
  QUESTION: 'question',
  DUPLICATE: 'duplicate',
  SPAM: 'spam',
  FEATURE_CREEP: 'feature_creep',
} as const;

export type TriageCategory = (typeof TriageCategory)[keyof typeof TriageCategory];

/** Result of triaging a single issue. */
export interface TriageResult {
  issueNumber: number;
  repo: string;
  category: TriageCategory;
  confidence: number;
  labelsToAdd: string[];
  labelsToRemove: string[];
  isDuplicate: boolean;
  duplicateOf: number | null;
  isSpam: boolean;
  isFeatureCreep: boolean;
  suggestedBreakdown: string[];
  priority: string;
  comment: string | null;
}

/** GitHub issue data for triage. */
export interface GitHubTriageIssue {
  number: number;
  title: string;
  body?: string;
  author: { login: string };
  createdAt: string;
  labels?: Array<{ name: string }>;
}

/** Progress callback for triage updates. */
export interface TriageProgressUpdate {
  phase: string;
  progress: number;
  message: string;
}

export type TriageProgressCallback = (update: TriageProgressUpdate) => void;

export const TRIAGE_SYSTEM_PROMPT =
  'Triage open source issues. Return structured JSON only.';

export const TRIAGE_PROMPT = `Analyze the following GitHub issue and triage it.

Determine:
1. **Category**: bug, feature, documentation, question, duplicate, spam, or feature_creep
2. **Priority**: high, medium, or low
3. **Labels to add/remove** based on category
4. **Duplicate detection**: Check if similar issues exist
5. **Spam detection**: Is this a low-quality or spam issue?
6. **Feature creep**: Does this request go beyond reasonable scope?

Respond with a JSON object:
{
  "category": "bug|feature|documentation|question|duplicate|spam|feature_creep",
  "confidence": 0.0-1.0,
  "priority": "high|medium|low",
  "labels_to_add": ["label1"],
  "labels_to_remove": ["label2"],
  "is_duplicate": false,
  "duplicate_of": null,
  "is_spam": false,
  "is_feature_creep": false,
  "suggested_breakdown": [],
  "comment": "optional comment to post on the issue"
}

Return valid JSON only; no markdown fence.`;

/**
 * Build context for triage including potential duplicates.
 */
export function buildTriageContext(issue: GitHubTriageIssue, allIssues: GitHubTriageIssue[]): string {
  const potentialDupes: GitHubTriageIssue[] = [];
  const titleWords = new Set(issue.title.toLowerCase().split(/\s+/));

  for (const other of allIssues) {
    if (other.number === issue.number) continue;
    const otherWords = new Set(other.title.toLowerCase().split(/\s+/));
    let overlap = 0;
    titleWords.forEach((word) => {
      if (otherWords.has(word)) overlap++;
    });
    const ratio = overlap / Math.max(titleWords.size, 1);
    if (ratio > 0.3) {
      potentialDupes.push(other);
    }
  }

  const labels = issue.labels?.map((l) => l.name).join(', ') ?? '';

  const lines: string[] = [
    `## Issue #${issue.number}`,
    `**Title:** ${issue.title}`,
    `**Author:** ${issue.author.login}`,
    `**Created:** ${issue.createdAt}`,
    `**Labels:** ${labels}`,
    '',
    '### Body',
    issue.body ?? 'No description',
    '',
  ];

  if (potentialDupes.length > 0) {
    lines.push('### Potential Duplicates (similar titles)');
    for (const duplicate of potentialDupes.slice(0, 5)) {
      lines.push(`- #${duplicate.number}: ${duplicate.title}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
