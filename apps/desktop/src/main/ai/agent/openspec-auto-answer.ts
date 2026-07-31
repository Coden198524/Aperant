import type { OpenSpecInteraction } from '../../../shared/types';

export type OpenSpecAutoAnswerQuestion = NonNullable<
  OpenSpecInteraction['questions']
>[number];

export type OpenSpecAutomaticInputResponder = (input: {
  questions: OpenSpecAutoAnswerQuestion[];
}) => Promise<string>;

const RECOMMENDED_OPTION_PATTERN =
  /\b(?:recommended|preferred|default)\b|推荐|建议|首选|默认|推奨|권장/i;
const DISCOURAGED_OPTION_PATTERN =
  /\b(?:not recommended|not preferred|not (?:the )?default|non-default|avoid (?:this|that) option)\b|不推荐|不建议|非默认|请勿选择|避开(?:此|该)?选项|非推奨|비추천/i;
const OTHER_OPTION_PATTERN =
  /^(?:other|custom|none(?:\s+of\s+the\s+above)?|autre|personnalis(?:é|ée|er)|其他|其它|自定义|以上都不是)(?=$|[\s:：(/（])/i;

export const OPEN_SPEC_AUTOMATIC_DECISION_HEADING =
  '## OPENSPEC AUTOMATIC DECISION REQUIREMENT';

export const OPEN_SPEC_AUTONOMOUS_ANSWER =
  'Automatic decision authorized: infer and commit to the most reasonable, ' +
  'lowest-risk, minimally disruptive, compatibility-preserving answer from ' +
  'the current repository and OpenSpec context. If the current Action permits ' +
  'writes, record any material assumption in the relevant artifact, then ' +
  'continue without asking the user again. Do not invent credentials, secrets, ' +
  'personal data, or external facts.';

const OPEN_SPEC_AUTONOMOUS_ANSWER_ZH_CN =
  '已授权自动决策：请根据当前仓库与 OpenSpec 上下文，采用风险最低、改动最小且保持兼容的具体答案。' +
  '当前 Action 允许写入时，将重要假设记录到相关 artifact，然后继续执行，不要再次询问用户。' +
  '不得编造凭据、秘密、个人信息或外部事实。';

const OPEN_SPEC_AUTONOMOUS_ANSWER_FR =
  'Décision automatique autorisée : déduisez et adoptez la réponse concrète ' +
  'la moins risquée, la moins intrusive et la plus compatible à partir du ' +
  'dépôt et du contexte OpenSpec. Si l’Action actuelle autorise les écritures, ' +
  'consignez toute hypothèse importante dans l’artifact concerné, puis ' +
  'continuez sans interroger de nouveau l’utilisateur. N’inventez jamais ' +
  'd’identifiants, de secrets, de données personnelles ni de faits externes.';

function resolveDecisionLanguage(language: string | undefined): 'en' | 'fr' | 'zh-CN' {
  const normalized = language?.trim().toLowerCase();
  if (normalized?.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalized?.startsWith('fr')) {
    return 'fr';
  }
  return 'en';
}

export function getOpenSpecAutomaticDecisionRequirement(
  language: string | undefined,
): string {
  switch (resolveDecisionLanguage(language)) {
    case 'zh-CN':
      return [
        '本次 Spec Action 已启用无人值守自动决策。',
        '遇到需要选择、澄清、确认或开放式回答时，不要暂停或等待人工输入。',
        '优先使用本次 Action 已提供的变更名、已选项和确认状态；否则选择明确标注为“推荐”“首选”或“默认”的选项。',
        '若无推荐项，选择原顺序中第一个可行且非“其他/自定义”的选项。',
        '开放式问题应依据 OpenSpec artifacts、任务描述和仓库证据，采用风险最低、改动最小且保持兼容的合理假设。',
        '仅在当前 Action 允许写入时，将重要假设记录到相关 artifact，然后继续执行。',
        '保持选项 label 原文，不得编造凭据、秘密、个人信息或外部事实。',
        '确实缺少必需的外部数据时，说明客观阻塞并安全停止；不要再次询问用户，也不要以问题结束。',
      ].join('\n');
    case 'fr':
      return [
        'Cette Action Spec utilise la prise de décision automatique sans surveillance.',
        'Lorsqu’un choix, une clarification, une confirmation ou une réponse libre est requis, ne vous interrompez pas et n’attendez pas une intervention humaine.',
        'Utilisez d’abord le nom du changement, les sélections et les confirmations déjà fournis par l’Action ; sinon, préférez une option explicitement marquée comme recommandée, préférée ou par défaut.',
        'À défaut, choisissez la première option réalisable qui n’est ni « autre » ni « personnalisée », dans l’ordre fourni.',
        'Pour une question libre, adoptez l’hypothèse raisonnable la moins risquée, la moins intrusive et la plus compatible d’après les artifacts OpenSpec, la tâche et le dépôt.',
        'Consignez les hypothèses importantes uniquement si l’Action actuelle autorise les écritures, puis continuez.',
        'Conservez les labels des options à l’identique et n’inventez jamais d’identifiants, de secrets, de données personnelles ni de faits externes.',
        'Si une donnée externe indispensable est réellement indisponible, signalez le blocage objectif et arrêtez-vous en sécurité ; ne reposez pas la question et ne terminez pas par une question.',
      ].join('\n');
    default:
      return [
        'This Spec Action uses unattended automatic decision-making.',
        'When a choice, clarification, confirmation, or open-ended answer is required, do not pause or wait for human input.',
        'First use any change name, selections, and confirmation state already supplied by the Action; otherwise prefer an option explicitly marked Recommended, Preferred, or Default.',
        'If none is marked, choose the first feasible non-Other/non-Custom option in the supplied order.',
        'For an open-ended question, make the lowest-risk, minimally disruptive, compatibility-preserving reasonable assumption supported by the OpenSpec artifacts, task, and repository.',
        'Record material assumptions only when the current Action permits writes, then continue.',
        'Preserve option labels exactly and do not invent credentials, secrets, personal data, or external facts.',
        'If indispensable external data is genuinely unavailable, report the objective blocker and stop safely; do not ask again or end with a question.',
      ].join('\n');
  }
}

export function appendOpenSpecAutomaticDecisionRequirement(
  message: string,
  language: string | undefined,
): string {
  if (message.includes(OPEN_SPEC_AUTOMATIC_DECISION_HEADING)) {
    return message;
  }
  return `${message}\n\n${OPEN_SPEC_AUTOMATIC_DECISION_HEADING}\n${
    getOpenSpecAutomaticDecisionRequirement(language)
  }`;
}

function getOpenSpecAutonomousAnswer(language: string | undefined): string {
  switch (resolveDecisionLanguage(language)) {
    case 'zh-CN':
      return OPEN_SPEC_AUTONOMOUS_ANSWER_ZH_CN;
    case 'fr':
      return OPEN_SPEC_AUTONOMOUS_ANSWER_FR;
    default:
      return OPEN_SPEC_AUTONOMOUS_ANSWER;
  }
}

function isRecommendedOption(option: {
  label: string;
  description?: string;
}): boolean {
  const text = `${option.label}\n${option.description ?? ''}`;
  return (
    RECOMMENDED_OPTION_PATTERN.test(text) &&
    !DISCOURAGED_OPTION_PATTERN.test(text)
  );
}

function isOtherOption(option: { label: string }): boolean {
  return OTHER_OPTION_PATTERN.test(option.label.trim().normalize('NFKC'));
}

function answerQuestion(
  question: OpenSpecAutoAnswerQuestion,
  language: string | undefined,
): string {
  const options = question.options?.filter((option) => option.label.trim()) ?? [];
  if (options.length === 0) {
    return getOpenSpecAutonomousAnswer(language);
  }

  const recommended = options.filter(isRecommendedOption);
  const selected = recommended.length > 0
    ? recommended
    : [options.find((option) => !isOtherOption(option)) ?? options[0]];
  const effectiveSelection = question.multiSelect
    ? selected
    : selected.slice(0, 1);

  return effectiveSelection.map((option) => option.label).join(', ');
}

export function resolveOpenSpecAutomaticAnswer(
  questions: ReadonlyArray<OpenSpecAutoAnswerQuestion>,
  language?: string,
): string {
  if (questions.length === 0) {
    return getOpenSpecAutonomousAnswer(language);
  }

  if (questions.length === 1) {
    return answerQuestion(questions[0], language);
  }

  return questions.map((question, index) => [
    `Question ${index + 1}${question.header ? ` (${question.header})` : ''}: ${question.question}`,
    `Answer: ${answerQuestion(question, language)}`,
  ].join('\n')).join('\n\n');
}

export function createOpenSpecAutomaticInputResponder(input: {
  agentType: string;
  openSpecRunId?: string;
  language?: string;
  abortSignal: AbortSignal;
}): OpenSpecAutomaticInputResponder | undefined {
  if (input.agentType !== 'openspec' || !input.openSpecRunId?.trim()) {
    return undefined;
  }

  return (request) => {
    if (input.abortSignal.aborted) {
      return Promise.reject(
        new DOMException('OpenSpec automatic answer was cancelled.', 'AbortError'),
      );
    }
    return Promise.resolve(
      resolveOpenSpecAutomaticAnswer(request.questions, input.language),
    );
  };
}
