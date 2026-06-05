export {
  DuplicateDetector,
  DUPLICATE_THRESHOLD,
  SIMILAR_THRESHOLD,
  extractEntities,
} from './duplicate-detector.js';
export type {
  DuplicateGroup,
  EntityExtraction,
  GitHubIssue as GitHubDuplicateIssue,
  SimilarityResult,
} from './duplicate-detector.js';

export {
  CostLimitExceeded,
  CostTracker,
  RateLimitExceeded,
  RateLimiter,
  TokenBucket,
} from './rate-limiter.js';
export type {
  RateLimiterConfig,
} from './rate-limiter.js';

export {
  TRIAGE_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
  TriageCategory,
  buildTriageContext,
} from './triage.js';
export type {
  GitHubTriageIssue,
  TriageProgressCallback,
  TriageProgressUpdate,
  TriageResult,
} from './triage.js';
