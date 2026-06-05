export type AutocodeTaskProfileAssignmentReason = 'proactive' | 'reactive' | 'manual';

export interface AutocodeTaskProfileAssignment {
  profileId: string;
  profileName: string;
  reason: AutocodeTaskProfileAssignmentReason;
  sessionId?: string;
}

export class AutocodeAgentState<TProcess extends { taskId: string } = { taskId: string }> {
  private processes: Map<string, TProcess> = new Map();
  private killedSpawnIds: Set<number> = new Set();
  private spawnCounter = 0;
  private taskProfileAssignments: Map<string, AutocodeTaskProfileAssignment> = new Map();

  generateSpawnId(): number {
    this.spawnCounter += 1;
    return this.spawnCounter;
  }

  addProcess(taskId: string, process: TProcess): void {
    this.processes.set(taskId, process);
  }

  getProcess(taskId: string): TProcess | undefined {
    return this.processes.get(taskId);
  }

  deleteProcess(taskId: string): boolean {
    return this.processes.delete(taskId);
  }

  hasProcess(taskId: string): boolean {
    return this.processes.has(taskId);
  }

  getRunningTaskIds(): string[] {
    return Array.from(this.processes.keys());
  }

  markSpawnAsKilled(spawnId: number): void {
    this.killedSpawnIds.add(spawnId);
  }

  wasSpawnKilled(spawnId: number): boolean {
    return this.killedSpawnIds.has(spawnId);
  }

  clearKilledSpawn(spawnId: number): void {
    this.killedSpawnIds.delete(spawnId);
  }

  updateProcess(taskId: string, updates: Partial<TProcess>): void {
    const existing = this.processes.get(taskId);
    if (existing) {
      this.processes.set(taskId, { ...existing, ...updates });
    }
  }

  getAllProcesses(): Map<string, TProcess> {
    return this.processes;
  }

  clear(): void {
    this.processes.clear();
    this.killedSpawnIds.clear();
    this.taskProfileAssignments.clear();
  }

  getRunningTasksByProfile(): { byProfile: Record<string, string[]>; totalRunning: number } {
    const byProfile: Record<string, string[]> = {};
    let totalRunning = 0;

    for (const [taskId] of this.processes) {
      const assignment = this.taskProfileAssignments.get(taskId);
      const profileId = assignment?.profileId || 'default';

      if (!byProfile[profileId]) {
        byProfile[profileId] = [];
      }
      byProfile[profileId].push(taskId);
      totalRunning += 1;
    }

    return { byProfile, totalRunning };
  }

  assignProfileToTask(
    taskId: string,
    profileId: string,
    profileName: string,
    reason: AutocodeTaskProfileAssignmentReason,
  ): void {
    const existing = this.taskProfileAssignments.get(taskId);
    this.taskProfileAssignments.set(taskId, {
      profileId,
      profileName,
      reason,
      sessionId: existing?.sessionId,
    });
  }

  getTaskProfileAssignment(taskId: string): AutocodeTaskProfileAssignment | undefined {
    return this.taskProfileAssignments.get(taskId);
  }

  updateTaskSession(
    taskId: string,
    sessionId: string,
    profileInfo?: { profileId: string; profileName: string },
  ): void {
    const assignment = this.taskProfileAssignments.get(taskId);
    if (assignment) {
      assignment.sessionId = sessionId;
      return;
    }

    this.taskProfileAssignments.set(taskId, {
      profileId: profileInfo?.profileId ?? 'unknown',
      profileName: profileInfo?.profileName ?? 'Unknown',
      reason: 'proactive',
      sessionId,
    });
  }

  getTaskSessionId(taskId: string): string | undefined {
    return this.taskProfileAssignments.get(taskId)?.sessionId;
  }

  clearTaskProfileAssignment(taskId: string): void {
    this.taskProfileAssignments.delete(taskId);
  }
}
