/**
 * Tamamlama snippet'i ve insan okunur etiket üretimi.
 *
 * Snippet: opsiyoneller atlanır, seçimlerde ilk seçenek kullanılır, yer tutucular
 * `${n:tür}` olur. Etiket: aynı iskelet, yer tutucular `…` ile kısaltılır.
 */

import type { PatternNode } from './ast'
import type { CompiledPattern } from './compiler'

export function patternToSnippet(pattern: CompiledPattern): string {
  let index = 0

  const visit = (node: PatternNode): string => {
    switch (node.type) {
      case 'literal':
        return escapeSnippetText(node.text)
      case 'optional':
        return ''
      case 'group':
        return visit(node.node)
      case 'choice':
        return node.alternatives.length > 0 ? visit(node.alternatives[0]!) : ''
      case 'sequence':
        return node.nodes.map(visit).join('')
      case 'placeholder': {
        index++
        return '${' + index + ':' + escapeSnippetText(node.info.types.join('/')) + '}'
      }
      case 'regex': {
        index++
        return '${' + index + ':' + escapeSnippetText(node.source) + '}'
      }
      case 'parse-tag':
        return ''
    }
  }

  return normalizeSpaces(visit(pattern.ast)) || normalizeSpaces(pattern.source)
}

export function patternToLabel(pattern: CompiledPattern): string {
  const visit = (node: PatternNode): string => {
    switch (node.type) {
      case 'literal':
        return node.text
      case 'optional':
        return ''
      case 'group':
        return visit(node.node)
      case 'choice':
        return node.alternatives.length > 0 ? visit(node.alternatives[0]!) : ''
      case 'sequence':
        return node.nodes.map(visit).join('')
      case 'placeholder':
      case 'regex':
        return '…'
      case 'parse-tag':
        return ''
    }
  }

  return normalizeSpaces(visit(pattern.ast)) || normalizeSpaces(pattern.source) || '…'
}

function escapeSnippetText(text: string): string {
  return text.replace(/[\\$}]/g, match => `\\${match}`)
}

function normalizeSpaces(text: string): string {
  return text.replace(/[ \t]+/g, ' ').trim()
}
