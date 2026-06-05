import { AutocodeAgentState } from '@autocode/core/runtime/agent-state';
import type { AgentProcess } from './types';

export type {
  AutocodeTaskProfileAssignment as TaskProfileAssignment,
  AutocodeTaskProfileAssignmentReason as TaskProfileAssignmentReason,
} from '@autocode/core/runtime/agent-state';

/**
 * Desktop adapter for the shared core agent state.
 */
export class AgentState extends AutocodeAgentState<AgentProcess> {}
