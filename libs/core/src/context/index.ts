export {
  extractKeywords,
} from './keyword-extractor.js';

export {
  categorizeMatches,
  type CategorizedFiles,
} from './categorizer.js';

export {
  suggestServices,
} from './service-matcher.js';

export type {
  CodePattern,
  ContextFile,
  FileMatch,
  ProjectIndex,
  ServiceInfo,
  ServiceMatch,
  SubtaskContext,
  TaskContext,
} from './types.js';
