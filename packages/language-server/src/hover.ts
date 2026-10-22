import { MarkupKind, type Hover, type Position } from 'vscode-languageserver'
import type { SyntaxEntry } from '@skript-ide/syntax-db'
import type { MatcherAdapter, SkriptDocument } from './contracts'
import type { DocumentAnalysis } from './document'
import { builtinFunctionMarkdown, functionMarkdown, optionMarkdown, syntaxMarkdown } from './markdown'
import { containsPosition } from './util'

import { l } from '@skript-ide/i18n'
export interface HoverFunction {
  uri: string
  definition: import('./contracts').FunctionDefinition
}

export interface HoverInput {
  uri: string
  doc: SkriptDocument
  analysis: DocumentAnalysis
  position: Position
  matcher: MatcherAdapter | null
  entries: readonly SyntaxEntry[]
  functions: readonly HoverFunction[]
}

export function computeHover(input: HoverInput): Hover | null {
  const { doc, position } = input

  for (const reference of doc.optionReferences) {
    if (!containsPosition(reference.range, position)) continue
    const option = doc.options.find(
      (candidate) => candidate.name.toLowerCase() === reference.name.toLowerCase()
    )
    if (!option) {
      return {
        contents: { kind: MarkupKind.Markdown, value: l(`**{@${reference.name}}** · tanımsız seçenek`, `**{@${reference.name}}** · undefined option`) },
        range: reference.range
      }
    }
    return {
      contents: { kind: MarkupKind.Markdown, value: optionMarkdown(option, input.uri, input.uri) },
      range: reference.range
    }
  }

  for (const call of doc.functionCalls) {
    if (!containsPosition(call.nameRange, position)) continue
    const definition = input.functions.find(
      (candidate) => candidate.definition.name.toLowerCase() === call.name.toLowerCase()
    )
    if (definition) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: functionMarkdown(definition.definition, definition.uri, input.uri)
        },
        range: call.nameRange
      }
    }
    const builtin = input.entries.find(
      (entry) => entry.kind === 'function' && entry.name.toLowerCase() === call.name.toLowerCase()
    )
    if (builtin) {
      return {
        contents: { kind: MarkupKind.Markdown, value: builtinFunctionMarkdown(builtin) },
        range: call.nameRange
      }
    }
  }

  for (const definition of doc.functions) {
    if (!containsPosition(definition.nameRange, position)) continue
    return {
      contents: { kind: MarkupKind.Markdown, value: functionMarkdown(definition, input.uri, input.uri) },
      range: definition.nameRange
    }
  }

  const context = input.analysis.lines.get(position.line)
  if (!context || context.kind === 'skip' || !input.matcher) return null

  const matches =
    context.kind === 'event'
      ? input.matcher.matchEvent(context.text)
      : context.kind === 'condition'
        ? input.matcher.match(context.text, ['condition'])
        : context.kind === 'section'
          ? input.matcher.match(context.text, ['section'])
          : input.matcher.match(context.text, ['effect', 'condition', 'section'])

  const best = matches[0]
  if (!best) return null
  return {
    contents: { kind: MarkupKind.Markdown, value: syntaxMarkdown(best.entry) },
    range: context.range
  }
}
