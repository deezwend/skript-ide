/**
 * `ask_user_question`: agent belirsiz bir noktada tahmin yürütmek yerine kullanıcıya çoktan seçmeli soru sorar.
 * Soruyu gösterme ve cevabı alma masaüstü uygulamasının işidir (`ToolContext.askUser`).
 */
import { defineTool, ToolError, type ToolContext, type UserQuestion } from '../tool'

/** Alt agent'lara verilmeyen tool'lar: kullanıcıyla yalnızca ana agent konuşur. */
export const ASK_USER_TOOL_NAMES: readonly string[] = ['ask_user_question']

export const MAX_QUESTIONS = 4
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 6

function validate(questions: unknown): UserQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) throw new ToolError('questions must be a non-empty array.')
  if (questions.length > MAX_QUESTIONS) throw new ToolError(`At most ${MAX_QUESTIONS} questions can be asked at once.`)
  return questions.map((raw, index): UserQuestion => {
    const entry = raw as Partial<UserQuestion> | null
    const question = typeof entry?.question === 'string' ? entry.question.trim() : ''
    if (!question) throw new ToolError(`questions[${index}].question is empty.`)
    const options = entry?.options
    if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      throw new ToolError(`questions[${index}].options must have ${MIN_OPTIONS}-${MAX_OPTIONS} items.`)
    }
    const labels = new Set<string>()
    const cleaned = options.map((option, optionIndex) => {
      const label = typeof option?.label === 'string' ? option.label.trim() : ''
      if (!label) throw new ToolError(`questions[${index}].options[${optionIndex}].label is empty.`)
      if (labels.has(label)) throw new ToolError(`questions[${index}] has the option "${label}" twice.`)
      labels.add(label)
      const description = typeof option.description === 'string' ? option.description.trim() : ''
      return description ? { label, description } : { label }
    })
    const header = typeof entry?.header === 'string' ? entry.header.trim() : ''
    return {
      question,
      ...(header ? { header: header.slice(0, 30) } : {}),
      options: cleaned,
      multiSelect: entry?.multiSelect === true
    }
  })
}

export const askUserQuestionTool = defineTool<{ questions: UserQuestion[] }>({
  name: 'ask_user_question',
  description:
    'Ask the user one or more multiple-choice questions and wait for the answers. Use it when the request is ambiguous, ' +
    'when there are several reasonable approaches and the choice is the user\'s, or when you need a preference before an ' +
    'expensive or hard-to-undo step. Do not ask what you can find out with the other tools, do not ask for permission ' +
    '(approvals are automatic), and do not ask more than needed. Put your recommended option first and say so in its label. ' +
    'The user can always type a different answer, so do not add an "Other" option.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: `1-${MAX_QUESTIONS} questions, shown together.`,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The complete question, ending with a question mark.' },
            header: { type: 'string', description: 'Very short label for the question (a few words).' },
            options: {
              type: 'array',
              description: `${MIN_OPTIONS}-${MAX_OPTIONS} distinct choices.`,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Short choice text (1-5 words).' },
                  description: { type: 'string', description: 'What this choice means or its trade-off.' }
                },
                required: ['label'],
                additionalProperties: false
              }
            },
            multiSelect: { type: 'boolean', description: 'Allow selecting several options (default false).' }
          },
          required: ['question', 'options'],
          additionalProperties: false
        }
      }
    },
    required: ['questions'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ questions }, ctx: ToolContext) {
    const list = validate(questions)
    if (!ctx.askUser) throw new ToolError('Asking the user is not available here. Make a reasonable choice and state your assumption.')
    const answers = await ctx.askUser(list)
    if (!answers) return 'The user dismissed the question without answering. Continue with your best judgment, or stop and say what you need.'
    return list
      .map((question, index) => {
        const picked = answers[index]?.filter((answer) => answer.trim()) ?? []
        return `Q: ${question.question}\nA: ${picked.length ? picked.join(', ') : '(no answer)'}`
      })
      .join('\n\n')
  }
})

export const askUserTools = [askUserQuestionTool]
