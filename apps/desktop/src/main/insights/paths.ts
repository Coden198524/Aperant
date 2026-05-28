import {
  getAutocodeInsightsCurrentSessionPath,
  getAutocodeInsightsDir,
  getAutocodeInsightsLegacySessionPath,
  getAutocodeInsightsSessionPath,
  getAutocodeInsightsSessionsDir,
} from '@autocode/core';

/**
 * Path utilities for insights service
 * Provides consistent path resolution for sessions and insights data
 */
export class InsightsPaths {
  constructor(private readonly dataDirName?: string) {}

  /**
   * Get insights directory path for a project
   */
  getInsightsDir(projectPath: string): string {
    return getAutocodeInsightsDir(projectPath, this.dataDirName);
  }

  /**
   * Get sessions directory path for a project
   */
  getSessionsDir(projectPath: string): string {
    return getAutocodeInsightsSessionsDir(projectPath, this.dataDirName);
  }

  /**
   * Validate that a session ID matches the expected safe pattern.
   * Prevents path traversal attacks via crafted session IDs.
   */
  private validateSessionId(sessionId: string): void {
    if (!/^session-\d{1,20}$/.test(sessionId)) {
      throw new Error('Invalid session ID format');
    }
  }

  /**
   * Get session file path for a specific session
   */
  getSessionPath(projectPath: string, sessionId: string): string {
    this.validateSessionId(sessionId);
    return getAutocodeInsightsSessionPath(projectPath, sessionId, this.dataDirName);
  }

  /**
   * Get current session pointer file path
   */
  getCurrentSessionPath(projectPath: string): string {
    return getAutocodeInsightsCurrentSessionPath(projectPath, this.dataDirName);
  }

  /**
   * Get old session path for migration
   */
  getOldSessionPath(projectPath: string): string {
    return getAutocodeInsightsLegacySessionPath(projectPath, this.dataDirName);
  }
}
