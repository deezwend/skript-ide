/**
 * Skript literal ve ifade biçimlerinin muhafazakâr tanınması.
 *
 * Amaç tam bir Skript ayrıştırıcısı olmak değil; bir yer tutucunun içinin
 * "kesin" sayılıp sayılamayacağını belirlemek. Emin olunamayan metinler için
 * çağıran taraf `structural` sonuç üretir.
 */

import {
  findBraceEnd,
  findParenEnd,
  findStringEnd,
  isBalancedExpressionText,
  splitTopLevelList
} from './scan'

export type LiteralCategory =
  | 'option'
  | 'string'
  | 'variable'
  | 'number'
  | 'timespan'
  | 'clock'
  | 'boolean'
  | 'argument'
  | 'event-value'
  | 'loop-value'
  | 'function-call'
  | 'parenthesized'
  | 'list'
  | 'bare-token'

const NUMBER_SOURCE = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
const NUMBER = new RegExp(`^${NUMBER_SOURCE}$`)
const UNIT_SOURCE = '(?:tick|second|minute|hour|day|week|month|year)s?'
const TIME_PREFIX_SOURCE = '(?:minecraft|mc|real|rl|irl)\\s+'
const TIMESPAN = new RegExp(
  `^(?:${NUMBER_SOURCE}\\s*(?:${TIME_PREFIX_SOURCE})?${UNIT_SOURCE})` +
    `(?:(?:\\s*,\\s*|\\s+and\\s+|\\s+)${NUMBER_SOURCE}\\s*(?:${TIME_PREFIX_SOURCE})?${UNIT_SOURCE})*$`,
  'i'
)
const CLOCK = [/^\d{1,2}:\d{2}(?::\d{2})?$/, /^\d{1,2}(?::\d{2})?\s*(?:am|pm)$/i, /^(?:noon|midnight|dawn|dusk)$/i]
const BOOLEAN = /^(?:true|false|yes|no|on|off)$/i
const ARGUMENT = new RegExp(
  '^(?:the\\s+)?(?:last\\s+|first\\s+|second\\s+|third\\s+|\\d+(?:st|nd|rd|th)\\s+)?' +
    '(?:all\\s+(?:of\\s+the\\s+)?)?arg(?:ument)?s?(?:[-\\s]?\\d+)?$',
  'i'
)
const EVENT_VALUE = /^(?:the\s+)?event(?:[-\s])\S.*$/i
const LOOP_VALUE = /^(?:the\s+)?(?:current\s+|next\s+|previous\s+)?loop(?:[-\s])\S.*$/i
const FUNCTION_CALL = /^([\p{L}_$][\p{L}\p{N}_$]*(?:[ ]+[\p{L}_$][\p{L}\p{N}_$]*)*)\s*\(([\s\S]*)\)$/u
const BARE_TOKEN = /^[\p{L}\p{N}_][\p{L}\p{N}_:.+\-]*$/u
const OPTION = /^\{@[^{}%]+\}$/

/** Metni bilinen bir literal/ifade biçimi olarak sınıflandırır. */
export function classifyLiteral(text: string): LiteralCategory | null {
  return classify(text.trim(), 0)
}

function classify(trimmed: string, depth: number): LiteralCategory | null {
  if (trimmed === '') return null

  if (OPTION.test(trimmed)) return 'option'
  if (isQuotedString(trimmed)) return 'string'
  if (trimmed.startsWith('{')) {
    const close = findBraceEnd(trimmed, 0)
    if (close === trimmed.length - 1) return 'variable'
  }
  if (NUMBER.test(trimmed)) return 'number'
  if (TIMESPAN.test(trimmed)) return 'timespan'
  if (CLOCK.some(pattern => pattern.test(trimmed))) return 'clock'
  if (BOOLEAN.test(trimmed)) return 'boolean'
  if (ARGUMENT.test(trimmed)) return 'argument'
  if (EVENT_VALUE.test(trimmed)) return 'event-value'
  if (LOOP_VALUE.test(trimmed)) return 'loop-value'
  if (isFunctionCall(trimmed)) return 'function-call'
  if (trimmed.startsWith('(') && findParenEnd(trimmed, 0) === trimmed.length - 1) {
    return 'parenthesized'
  }
  if (BARE_TOKEN.test(trimmed)) return 'bare-token'

  if (depth < 3) {
    const parts = splitTopLevelList(trimmed)
    if (
      parts.length > 1 &&
      parts.every(part => part !== trimmed && classify(part, depth + 1) !== null)
    ) {
      return 'list'
    }
  }

  return null
}

/** `%*tip%` bağlamında kabul edilebilecek literal mi? */
export function isLiteralOnlyText(text: string): boolean {
  const category = classifyLiteral(text)
  if (category === null) return false
  if (
    category === 'variable' ||
    category === 'function-call' ||
    category === 'parenthesized' ||
    category === 'list'
  ) {
    return false
  }
  if (category === 'string') {
    // `"a %player% b"` Skript'te VariableString'dir, düz literal değildir.
    return !text.includes('%')
  }
  return true
}

/** `%~tip%` bağlamında değiştirilebilir bir ifade mi? (Muhafazakâr: yalnızca değişken.) */
export function isChangeableText(text: string): boolean {
  const trimmed = text.trim()
  if (classifyLiteral(trimmed) === 'list') {
    return splitTopLevelList(trimmed).every(part => isChangeableText(part))
  }
  if (!trimmed.startsWith('{')) return false
  if (OPTION.test(trimmed)) return false
  return findBraceEnd(trimmed, 0) === trimmed.length - 1
}

/** Yapısal (structural) kabul için: dengeli ve tek satırlık her metin. */
export function isPlausiblePlaceholderText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (trimmed.includes('\n') || trimmed.includes('\r')) return false
  return isBalancedExpressionText(trimmed)
}

function isQuotedString(text: string): boolean {
  if (!text.startsWith('"')) return false
  const close = findStringEnd(text, 0)
  return close === text.length - 1
}

function isFunctionCall(text: string): boolean {
  const match = FUNCTION_CALL.exec(text)
  if (match === null) return false
  const name = match[1]?.trim() ?? ''
  if (name === '') return false
  const open = text.indexOf('(')
  return findParenEnd(text, open) === text.length - 1
}
