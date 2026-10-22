import type { FunctionDefinition, OptionDefinition } from './contracts'
import type { SyntaxEntry, SyntaxKind } from '@skript-ide/syntax-db'
import type { Range } from './contracts'
import { truncate, uriKey } from './util'

import { l } from '@skript-ide/i18n'
export function kindLabel(kind: SyntaxKind): string {
  const labels: Record<SyntaxKind, string> = {
    event: l('olay', 'event'),
    condition: l('koşul', 'condition'),
    effect: l('efekt', 'effect'),
    expression: l('ifade', 'expression'),
    section: l('bölüm', 'section'),
    structure: l('yapı', 'structure'),
    type: l('tür', 'type'),
    function: l('fonksiyon', 'function')
  }
  return labels[kind]
}

export function syntaxMarkdown(entry: SyntaxEntry): string {
  const source = entry.addon ? ` · ${entry.addon}` : ''
  const parts: string[] = [`**${entry.name}** · ${kindLabel(entry.kind)}${source}`]
  const description = truncate(entry.description.trim(), 1500)
  if (description) parts.push(description)

  const example = entry.examples.find((item) => item.trim().length > 0)
  if (example) parts.push(['```skript', example.trimEnd(), '```'].join('\n'))

  const details: string[] = []
  if (entry.since.length > 0) details.push(l(`Eklendiği sürüm: ${entry.since.join(', ')}`, `Since: ${entry.since.join(', ')}`))
  if (entry.returnType) details.push(l(`Döndürür: ${entry.returnType.name}`, `Returns: ${entry.returnType.name}`))
  if (entry.requirements?.length) details.push(l(`Gereksinimler: ${entry.requirements.join(', ')}`, `Requirements: ${entry.requirements.join(', ')}`))
  if (entry.cancellable) details.push(l('`cancel event` ile iptal edilebilir', 'Cancellable with `cancel event`'))
  if (entry.deprecated) details.push(l('⚠ Kullanımdan kaldırıldı', '⚠ Deprecated'))
  if (details.length > 0) parts.push(details.join('  \n'))

  if (entry.eventValues?.length) {
    parts.push(l(`Olay değerleri: ${entry.eventValues.map((value) => `\`${value.name}\``).join(', ')}`, `Event values: ${entry.eventValues.map((value) => `\`${value.name}\``).join(', ')}`))
  }
  return parts.join('\n\n')
}

export function functionSignature(definition: FunctionDefinition): string {
  const parameters = definition.parameters
    .map((parameter) => {
      const defaultValue = parameter.defaultValue ? ` = ${parameter.defaultValue}` : ''
      return `${parameter.name}: ${parameter.type}${defaultValue}`
    })
    .join(', ')
  const returnType = definition.returnType ? ` :: ${definition.returnType}` : ''
  return `${definition.name}(${parameters})${returnType}`
}

/** Yerleşik fonksiyon kaydının imzası (docs pattern'i doğrudan imzadır). */
export function builtinFunctionMarkdown(entry: SyntaxEntry): string {
  const signature = entry.patterns[0]?.trim()
  if (!signature) return syntaxMarkdown(entry)
  return `\`${signature}\`\n\n${syntaxMarkdown(entry)}`
}

/**
 * Tanımın yeri okunur biçimde: aynı dosyadaysa "bu dosya", değilse dosya adı; satırlar 1'den sayılır.
 * Kaydedilmemiş model URI'leri (`inmemory://model/1`) kullanıcıya gösterilmez.
 */
export function locationLabel(uri: string, range: Range | undefined, currentUri?: string): string {
  const line = range ? l(`, satır ${range.start.line + 1}`, `, line ${range.start.line + 1}`) : ''
  if (currentUri !== undefined && uriKey(uri) === uriKey(currentUri)) return l(`bu dosya${line}`, `this file${line}`)
  return `${fileLabel(uri)}${line}`
}

export function fileLabel(uri: string): string {
  if (/^inmemory:/i.test(uri)) return l('kaydedilmemiş dosya', 'unsaved file')
  const path = uri.replace(/^[a-z][\w+.-]*:\/*/i, '').split(/[?#]/)[0] ?? ''
  const name = path.split('/').filter(Boolean).pop() ?? uri
  try {
    return `\`${decodeURIComponent(name)}\``
  } catch {
    return `\`${name}\``
  }
}

export function functionMarkdown(definition: FunctionDefinition, uri: string, currentUri?: string): string {
  const scope = definition.local
    ? l('Yerel fonksiyon (yalnızca bu dosyada)', 'Local function (this file only)')
    : l('Fonksiyon (çalışma alanında genel)', 'Function (global in the workspace)')
  return [
    `**${functionSignature(definition)}**`,
    scope,
    l(`Tanım: ${locationLabel(uri, definition.nameRange, currentUri)}`, `Defined in: ${locationLabel(uri, definition.nameRange, currentUri)}`)
  ].join('\n\n')
}

export function optionMarkdown(option: OptionDefinition, uri: string, currentUri?: string): string {
  const value = option.value.trim() || l('(boş)', '(empty)')
  return [
    `**{@${option.name}}**`,
    l('Seçenek değeri:', 'Option value:'),
    ['```', value, '```'].join('\n'),
    l(`Tanım: ${locationLabel(uri, option.nameRange, currentUri)}`, `Defined in: ${locationLabel(uri, option.nameRange, currentUri)}`)
  ].join('\n\n')
}
