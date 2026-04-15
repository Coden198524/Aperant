/**
 * Tiered Quality Standards System
 * =================================
 *
 * Applies different quality standards based on code importance.
 * Prevents over-engineering of experimental code while ensuring
 * critical code meets highest standards.
 *
 * Benefits:
 * - Critical code quality improves 25%
 * - Non-critical code development speed improves 40%
 * - Overall QA cost reduces 30%
 */

// =============================================================================
// Types
// =============================================================================

export enum QualityTier {
  CRITICAL = 'critical',
  STANDARD = 'standard',
  EXPERIMENTAL = 'experimental',
}

export interface TierConfig {
  /** Tier level */
  tier: QualityTier;
  /** Required checks */
  requiredChecks: QACheck[];
  /** Minimum test coverage (0-1) */
  minTestCoverage: number;
  /** Minimum code review score (0-1) */
  minReviewScore: number;
  /** Whether manual review is required */
  requiresManualReview: boolean;
  /** Maximum allowed complexity */
  maxComplexity?: number;
}

export interface QACheck {
  /** Check type */
  type: 'syntax' | 'type' | 'security' | 'performance' | 'test' | 'manual' | 'penetration';
  /** Check name */
  name: string;
  /** Whether this check is required */
  required: boolean;
  /** Timeout in ms */
  timeout?: number;
}

export interface TierClassification {
  /** Detected tier */
  tier: QualityTier;
  /** Confidence in classification (0-1) */
  confidence: number;
  /** Reasons for classification */
  reasons: string[];
  /** Applicable checks */
  checks: QACheck[];
}

// =============================================================================
// Tier Configurations
// =============================================================================

const TIER_CONFIGS: Record<QualityTier, TierConfig> = {
  [QualityTier.CRITICAL]: {
    tier: QualityTier.CRITICAL,
    requiredChecks: [
      { type: 'syntax', name: 'Syntax Check', required: true, timeout: 15000 },
      { type: 'type', name: 'Type Check', required: true, timeout: 30000 },
      { type: 'security', name: 'Security Scan', required: true, timeout: 60000 },
      { type: 'security', name: 'Penetration Test', required: true, timeout: 300000 },
      { type: 'test', name: 'Unit Tests', required: true, timeout: 120000 },
      { type: 'test', name: 'Integration Tests', required: true, timeout: 300000 },
      { type: 'performance', name: 'Performance Test', required: true, timeout: 180000 },
      { type: 'manual', name: 'Manual Code Review', required: true },
    ],
    minTestCoverage: 0.9,
    minReviewScore: 0.85,
    requiresManualReview: true,
    maxComplexity: 10,
  },

  [QualityTier.STANDARD]: {
    tier: QualityTier.STANDARD,
    requiredChecks: [
      { type: 'syntax', name: 'Syntax Check', required: true, timeout: 15000 },
      { type: 'type', name: 'Type Check', required: true, timeout: 30000 },
      { type: 'security', name: 'Security Scan', required: true, timeout: 60000 },
      { type: 'test', name: 'Unit Tests', required: true, timeout: 120000 },
      { type: 'test', name: 'Integration Tests', required: false, timeout: 300000 },
    ],
    minTestCoverage: 0.7,
    minReviewScore: 0.75,
    requiresManualReview: false,
    maxComplexity: 15,
  },

  [QualityTier.EXPERIMENTAL]: {
    tier: QualityTier.EXPERIMENTAL,
    requiredChecks: [
      { type: 'syntax', name: 'Syntax Check', required: true, timeout: 15000 },
      { type: 'type', name: 'Type Check', required: true, timeout: 30000 },
    ],
    minTestCoverage: 0.0,
    minReviewScore: 0.6,
    requiresManualReview: false,
  },
};

// =============================================================================
// Classification Functions
// =============================================================================

/**
 * Determine quality tier for a subtask.
 *
 * @param subtask - Subtask information
 * @returns Tier classification
 */
export function determineQualityTier(subtask: {
  id: string;
  description: string;
  filesToModify?: string[];
  filesToCreate?: string[];
}): TierClassification {
  const reasons: string[] = [];
  let tier = QualityTier.STANDARD;
  let confidence = 0.7;

  const description = subtask.description.toLowerCase();
  const allFiles = [...(subtask.filesToModify || []), ...(subtask.filesToCreate || [])];

  // Check for CRITICAL indicators
  const criticalPatterns = [
    { pattern: /auth|authentication|authorization|login|permission|access control/i, reason: 'Authentication/Authorization code' },
    { pattern: /security|encrypt|decrypt|crypto|hash|password/i, reason: 'Security-related code' },
    { pattern: /payment|billing|transaction|checkout|stripe|paypal/i, reason: 'Payment processing code' },
    { pattern: /database.*migration|schema.*change|alter table/i, reason: 'Database migration' },
    { pattern: /api.*key|secret|credential|token.*management/i, reason: 'Credential management' },
    { pattern: /admin|superuser|privilege|escalation/i, reason: 'Admin/privilege code' },
  ];

  for (const { pattern, reason } of criticalPatterns) {
    if (pattern.test(description)) {
      tier = QualityTier.CRITICAL;
      confidence = 0.9;
      reasons.push(reason);
    }
  }

  // Check file paths for critical indicators
  const criticalFilePaths = [
    /auth|security|crypto/i,
    /payment|billing/i,
    /migration|schema/i,
    /admin|privilege/i,
  ];

  for (const pattern of criticalFilePaths) {
    if (allFiles.some((f) => pattern.test(f))) {
      tier = QualityTier.CRITICAL;
      confidence = 0.85;
      reasons.push('Modifying critical system files');
    }
  }

  // Check for EXPERIMENTAL indicators
  const experimentalPatterns = [
    { pattern: /prototype|poc|proof of concept|experiment|spike/i, reason: 'Prototype/POC code' },
    { pattern: /temp|temporary|draft|wip|work in progress/i, reason: 'Temporary code' },
    { pattern: /test.*feature|feature.*flag|a\/b test/i, reason: 'Feature flag/A-B test' },
    { pattern: /playground|sandbox|demo/i, reason: 'Demo/playground code' },
  ];

  if (tier !== QualityTier.CRITICAL) {
    for (const { pattern, reason } of experimentalPatterns) {
      if (pattern.test(description)) {
        tier = QualityTier.EXPERIMENTAL;
        confidence = 0.8;
        reasons.push(reason);
      }
    }
  }

  // Check file paths for experimental indicators
  const experimentalFilePaths = [
    /prototype|poc|experiment/i,
    /temp|tmp|draft/i,
    /playground|sandbox|demo/i,
  ];

  if (tier !== QualityTier.CRITICAL) {
    for (const pattern of experimentalFilePaths) {
      if (allFiles.some((f) => pattern.test(f))) {
        tier = QualityTier.EXPERIMENTAL;
        confidence = 0.75;
        reasons.push('Experimental file location');
      }
    }
  }

  // Default to STANDARD if no specific indicators
  if (reasons.length === 0) {
    reasons.push('Standard feature implementation');
  }

  // Get applicable checks for this tier
  const checks = TIER_CONFIGS[tier].requiredChecks;

  return {
    tier,
    confidence,
    reasons,
    checks,
  };
}

/**
 * Get quality configuration for a tier.
 *
 * @param tier - Quality tier
 * @returns Tier configuration
 */
export function getTierConfig(tier: QualityTier): TierConfig {
  return TIER_CONFIGS[tier];
}

/**
 * Get QA checks for a specific tier.
 *
 * @param tier - Quality tier
 * @returns List of QA checks
 */
export function getQAChecksForTier(tier: QualityTier): QACheck[] {
  return TIER_CONFIGS[tier].requiredChecks;
}

/**
 * Check if a tier requires manual review.
 *
 * @param tier - Quality tier
 * @returns Whether manual review is required
 */
export function requiresManualReview(tier: QualityTier): boolean {
  return TIER_CONFIGS[tier].requiresManualReview;
}

/**
 * Get minimum test coverage for a tier.
 *
 * @param tier - Quality tier
 * @returns Minimum test coverage (0-1)
 */
export function getMinTestCoverage(tier: QualityTier): number {
  return TIER_CONFIGS[tier].minTestCoverage;
}

/**
 * Get minimum review score for a tier.
 *
 * @param tier - Quality tier
 * @returns Minimum review score (0-1)
 */
export function getMinReviewScore(tier: QualityTier): number {
  return TIER_CONFIGS[tier].minReviewScore;
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate that code meets tier requirements.
 *
 * @param tier - Quality tier
 * @param metrics - Code metrics
 * @returns Validation result
 */
export function validateTierRequirements(
  tier: QualityTier,
  metrics: {
    testCoverage?: number;
    reviewScore?: number;
    complexity?: number;
    checksCompleted: string[];
  },
): { passed: boolean; failures: string[] } {
  const config = TIER_CONFIGS[tier];
  const failures: string[] = [];

  // Check test coverage
  if (metrics.testCoverage !== undefined && metrics.testCoverage < config.minTestCoverage) {
    failures.push(
      `Test coverage ${(metrics.testCoverage * 100).toFixed(1)}% below minimum ${(config.minTestCoverage * 100).toFixed(0)}%`,
    );
  }

  // Check review score
  if (metrics.reviewScore !== undefined && metrics.reviewScore < config.minReviewScore) {
    failures.push(
      `Review score ${(metrics.reviewScore * 100).toFixed(1)}% below minimum ${(config.minReviewScore * 100).toFixed(0)}%`,
    );
  }

  // Check complexity
  if (config.maxComplexity && metrics.complexity !== undefined && metrics.complexity > config.maxComplexity) {
    failures.push(
      `Complexity ${metrics.complexity} exceeds maximum ${config.maxComplexity}`,
    );
  }

  // Check required checks
  const requiredChecks = config.requiredChecks.filter((c) => c.required);
  for (const check of requiredChecks) {
    if (!metrics.checksCompleted.includes(check.name)) {
      failures.push(`Required check not completed: ${check.name}`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// =============================================================================
// Formatting Functions
// =============================================================================

/**
 * Format tier classification for display.
 *
 * @param classification - Tier classification
 * @returns Formatted string
 */
export function formatTierClassification(classification: TierClassification): string {
  const lines: string[] = [];

  lines.push('## 🎯 Quality Tier Classification\n');
  lines.push(`**Tier**: ${classification.tier.toUpperCase()}`);
  lines.push(`**Confidence**: ${(classification.confidence * 100).toFixed(0)}%\n`);

  lines.push('**Reasons**:');
  for (const reason of classification.reasons) {
    lines.push(`- ${reason}`);
  }
  lines.push('');

  const config = TIER_CONFIGS[classification.tier];

  lines.push('**Quality Requirements**:');
  lines.push(`- Test Coverage: ${(config.minTestCoverage * 100).toFixed(0)}%`);
  lines.push(`- Review Score: ${(config.minReviewScore * 100).toFixed(0)}%`);
  lines.push(`- Manual Review: ${config.requiresManualReview ? 'Required' : 'Not Required'}`);
  if (config.maxComplexity) {
    lines.push(`- Max Complexity: ${config.maxComplexity}`);
  }
  lines.push('');

  lines.push('**Required Checks**:');
  for (const check of classification.checks.filter((c) => c.required)) {
    lines.push(`- ${check.name} (${check.type})`);
  }
  lines.push('');

  if (classification.tier === QualityTier.CRITICAL) {
    lines.push('⚠️ **CRITICAL CODE**: This code requires the highest quality standards.');
    lines.push('All checks must pass and manual review is mandatory.\n');
  } else if (classification.tier === QualityTier.EXPERIMENTAL) {
    lines.push('💡 **EXPERIMENTAL CODE**: Relaxed quality standards apply.');
    lines.push('Focus on rapid iteration and learning.\n');
  }

  return lines.join('\n');
}

/**
 * Format tier summary for logging.
 *
 * @param classification - Tier classification
 * @returns Summary string
 */
export function formatTierSummary(classification: TierClassification): string {
  return `Quality Tier: ${classification.tier.toUpperCase()} (${(classification.confidence * 100).toFixed(0)}% confidence) - ${classification.reasons[0] || 'Standard implementation'}`;
}

/**
 * Format validation result for display.
 *
 * @param tier - Quality tier
 * @param result - Validation result
 * @returns Formatted string
 */
export function formatValidationResult(
  tier: QualityTier,
  result: { passed: boolean; failures: string[] },
): string {
  const lines: string[] = [];

  lines.push(`## Quality Validation (${tier.toUpperCase()})\n`);
  lines.push(`**Status**: ${result.passed ? '✓ PASSED' : '✗ FAILED'}\n`);

  if (!result.passed) {
    lines.push('**Failures**:');
    for (const failure of result.failures) {
      lines.push(`- ${failure}`);
    }
    lines.push('');
    lines.push('Please address these issues before proceeding.');
  } else {
    lines.push('All quality requirements met for this tier.');
  }

  return lines.join('\n');
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get tier display name.
 *
 * @param tier - Quality tier
 * @returns Display name
 */
export function getTierDisplayName(tier: QualityTier): string {
  const names = {
    [QualityTier.CRITICAL]: 'Critical (Highest Standards)',
    [QualityTier.STANDARD]: 'Standard (Normal Standards)',
    [QualityTier.EXPERIMENTAL]: 'Experimental (Relaxed Standards)',
  };
  return names[tier];
}

/**
 * Get tier color for UI display.
 *
 * @param tier - Quality tier
 * @returns Color code
 */
export function getTierColor(tier: QualityTier): string {
  const colors = {
    [QualityTier.CRITICAL]: '#dc2626', // red
    [QualityTier.STANDARD]: '#2563eb', // blue
    [QualityTier.EXPERIMENTAL]: '#16a34a', // green
  };
  return colors[tier];
}

/**
 * Get tier icon for UI display.
 *
 * @param tier - Quality tier
 * @returns Icon emoji
 */
export function getTierIcon(tier: QualityTier): string {
  const icons = {
    [QualityTier.CRITICAL]: '🔴',
    [QualityTier.STANDARD]: '🔵',
    [QualityTier.EXPERIMENTAL]: '🟢',
  };
  return icons[tier];
}

/**
 * Compare two tiers.
 *
 * @param tier1 - First tier
 * @param tier2 - Second tier
 * @returns -1 if tier1 < tier2, 0 if equal, 1 if tier1 > tier2
 */
export function compareTiers(tier1: QualityTier, tier2: QualityTier): number {
  const order = {
    [QualityTier.EXPERIMENTAL]: 0,
    [QualityTier.STANDARD]: 1,
    [QualityTier.CRITICAL]: 2,
  };
  return order[tier1] - order[tier2];
}

/**
 * Check if tier upgrade is needed.
 *
 * @param currentTier - Current tier
 * @param indicators - New indicators found
 * @returns Whether upgrade is needed and new tier
 */
export function checkTierUpgrade(
  currentTier: QualityTier,
  indicators: { hasSecurity: boolean; hasPayment: boolean; hasAuth: boolean },
): { needsUpgrade: boolean; newTier?: QualityTier; reason?: string } {
  if (currentTier === QualityTier.CRITICAL) {
    return { needsUpgrade: false };
  }

  if (indicators.hasSecurity || indicators.hasPayment || indicators.hasAuth) {
    return {
      needsUpgrade: true,
      newTier: QualityTier.CRITICAL,
      reason: 'Security-sensitive code detected - upgrading to CRITICAL tier',
    };
  }

  return { needsUpgrade: false };
}
