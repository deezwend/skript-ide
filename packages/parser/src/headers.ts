import type { StructureKind } from './types.js'
import {
  findMatchingParen,
  findTopLevelCharacter,
  splitTopLevel
} from './text-utils.js'

import { l } from '@skript-ide/i18n'
export interface HeaderDiagnostic {
  /** Header metnine göre başlangıç. */
  start: number
  /** Header metnine göre bitiş (dahil değil). */
  end: number
  code: string
  message: string
}

export interface ParsedFunctionParameter {
  name: string
  type: string
  defaultValue?: string
  /** Header metnine göre parametrenin tamamı. */
  start: number
  end: number
  nameStart: number
  nameEnd: number
  defaultStart?: number
  defaultEnd?: number
}

export interface ParsedFunctionSignature {
  name: string
  nameStart: number
  nameEnd: number
  parameters: ParsedFunctionParameter[]
  returnType?: string
  returnStart?: number
  returnEnd?: number
  local: boolean
  valid: boolean
  diagnostics: HeaderDiagnostic[]
}

export interface ClassifiedHeader {
  kind: StructureKind
  /** Header metnine göre. */
  name?: string
  nameStart?: number
  nameEnd?: number
  signature?: ParsedFunctionSignature
  /** `function` anahtar sözcüğü var ama imza okunamadı. */
  invalidSignature?: boolean
  /** `using ...`, `import ...`, `auto reload` gibi gövdesiz yapılar. */
  simple?: boolean
}

const FUNCTION_PREFIX = /^(local\s+)?function(?=\s|$)/i
const COMMAND_PREFIX = /^command(?=\s|$)/i
const EVENT_PREFIX = /^(on|every|at|cancelled|uncancelled|any|all)(?=\s|$)/i
const SIMPLE_STRUCTURE = /^(?:using|import)(?=\s|$)|^auto(?:matically)?\s+reload(?=\s|$)/i

function splitSignatureParameters(
  header: string,
  openParen: number,
  closeParen: number
): { parameters: ParsedFunctionParameter[]; diagnostics: HeaderDiagnostic[] } {
  const parameters: ParsedFunctionParameter[] = []
  const diagnostics: HeaderDiagnostic[] = []
  const args = header.slice(openParen + 1, closeParen)
  if (args.trim().length === 0) {
    return { parameters, diagnostics }
  }
  const slices = splitTopLevel(args, ',')
  const seen = new Set<string>()

  for (const slice of slices) {
    const start = openParen + 1 + slice.trimmedStart
    const end = openParen + 1 + slice.trimmedEnd
    const raw = header.slice(start, end)
    if (raw.length === 0) {
      diagnostics.push({
        start,
        end: start + 1,
        code: 'function-invalid-parameter',
        message: l("Boş fonksiyon parametresi.", "Empty function parameter.")
      })
      continue
    }

    const colon = findTopLevelCharacter(header, ':', start, end)
    if (colon < 0) {
      diagnostics.push({
        start,
        end,
        code: 'function-invalid-parameter',
        message: l("Fonksiyon parametresi 'ad: tür' biçiminde olmalı.", "Function parameter must be in the form 'name: type'.")
      })
      continue
    }

    let nameStart = start
    while (nameStart < colon && /\s/.test(header.charAt(nameStart))) nameStart++
    let nameEnd = colon
    while (nameEnd > nameStart && /\s/.test(header.charAt(nameEnd - 1))) nameEnd--
    const name = header.slice(nameStart, nameEnd)

    if (name.length === 0) {
      diagnostics.push({
        start,
        end: colon + 1,
        code: 'function-invalid-parameter',
        message: l("Fonksiyon parametresinin adı boş olamaz.", "Function parameter name cannot be empty.")
      })
      continue
    }

    const equals = findTopLevelCharacter(header, '=', colon + 1, end)
    const typeStart = colon + 1
    const typeEnd = equals < 0 ? end : equals
    const type = header.slice(typeStart, typeEnd).trim()
    const defaultValue = equals < 0 ? undefined : header.slice(equals + 1, end).trim()

    if (type.length === 0) {
      diagnostics.push({
        start,
        end,
        code: 'function-invalid-parameter',
        message: l("Fonksiyon parametresinin türü boş olamaz.", "Function parameter type cannot be empty.")
      })
      continue
    }
    if (defaultValue !== undefined && defaultValue.length === 0) {
      diagnostics.push({
        start: equals,
        end,
        code: 'function-invalid-parameter',
        message: l("Varsayılan değer boş olamaz.", "Default value cannot be empty.")
      })
      continue
    }
    if (seen.has(name)) {
      diagnostics.push({
        start: nameStart,
        end: nameEnd,
        code: 'function-duplicate-parameter',
        message: l(`Aynı ada sahip birden fazla parametre var: '${name}'.`, `More than one parameter has the same name: '${name}'.`)
      })
    }
    seen.add(name)

    const parameter: ParsedFunctionParameter = {
      name,
      type,
      start,
      end,
      nameStart,
      nameEnd
    }
    if (defaultValue !== undefined) {
      parameter.defaultValue = defaultValue
      let defaultStart = equals + 1
      while (defaultStart < end && /\s/.test(header.charAt(defaultStart))) defaultStart++
      parameter.defaultStart = defaultStart
      parameter.defaultEnd = defaultStart + defaultValue.length
    }
    parameters.push(parameter)
  }

  return { parameters, diagnostics }
}

function parseFunctionSignature(
  header: string,
  local: boolean,
  match: RegExpExecArray
): ParsedFunctionSignature {
  const matched = match[0]
  const name = match[2] ?? ''
  const prefixMatch = /^(?:local\s+)?function\s+/i.exec(matched)
  const prefixLength = prefixMatch === null ? 0 : prefixMatch[0].length
  const nameStart = match.index + prefixLength
  const nameEnd = nameStart + name.length
  const openParen = match.index + matched.length - 1
  const diagnostics: HeaderDiagnostic[] = []

  if (name.length === 0) {
    return {
      name: '',
      nameStart,
      nameEnd,
      parameters: [],
      local,
      valid: false,
      diagnostics: [
        {
          start: 0,
          end: header.length,
          code: 'function-invalid-signature',
          message: l('Geçersiz fonksiyon imzası.', 'Invalid function signature.')
        }
      ]
    }
  }

  const closeParen = findMatchingParen(header, openParen)
  if (closeParen < 0) {
    return {
      name,
      nameStart,
      nameEnd,
      parameters: [],
      local,
      valid: false,
      diagnostics: [
        {
          start: openParen,
          end: Math.max(openParen + 1, header.length),
          code: 'function-invalid-signature',
          message: l("Fonksiyon imzasında kapanmamış ')' var.", "Unclosed ')' in function signature.")
        }
      ]
    }
  }

  const { parameters, diagnostics: parameterDiagnostics } = splitSignatureParameters(
    header,
    openParen,
    closeParen
  )
  diagnostics.push(...parameterDiagnostics)

  const rest = header.slice(closeParen + 1)
  let returnType: string | undefined
  let returnStart: number | undefined
  let returnEnd: number | undefined

  if (rest.trim().length > 0) {
    const prefix = /^\s*(?:->|::|returns\b)\s*/i.exec(rest)
    if (prefix === null) {
      diagnostics.push({
        start: closeParen + 1,
        end: header.length,
        code: 'function-invalid-signature',
        message: l("Dönüş türü '::', '->' ya da 'returns' ile belirtilmeli.", "Return type must be given with '::', '->' or 'returns'.")
      })
    } else {
      const valuePart = rest.slice(prefix[0].length)
      const value = valuePart.trim()
      if (value.length === 0) {
        diagnostics.push({
          start: closeParen + 1,
          end: header.length,
          code: 'function-invalid-signature',
          message: l('Dönüş türü boş olamaz.', 'Return type cannot be empty.')
        })
      } else {
        const leading = valuePart.length - valuePart.trimStart().length
        returnType = value
        returnStart = closeParen + 1 + prefix[0].length + leading
        returnEnd = returnStart + value.length
      }
    }
  }

  const valid = diagnostics.length === 0
  const signature: ParsedFunctionSignature = {
    name,
    nameStart,
    nameEnd,
    parameters,
    local,
    valid,
    diagnostics
  }
  if (returnType !== undefined) signature.returnType = returnType
  if (returnStart !== undefined) signature.returnStart = returnStart
  if (returnEnd !== undefined) signature.returnEnd = returnEnd
  return signature
}

export function classifyHeader(header: string): ClassifiedHeader {
  const lower = header.trim().toLowerCase()

  if (lower === 'options') return { kind: 'options' }
  if (lower === 'variables') return { kind: 'variables' }
  if (lower === 'aliases') return { kind: 'aliases' }

  const functionMatch = /^(local\s+)?function\s+([\p{L}_][\p{L}\d_]*)\s*(\()/iu.exec(header)
  if (functionMatch !== null) {
    const local = functionMatch[1] !== undefined
    const prefix = /^(?:local\s+)?function\s+/i.exec(functionMatch[0])
    const prefixLength = prefix === null ? 0 : prefix[0].length
    const name = functionMatch[2] ?? ''
    const nameStart = functionMatch.index + prefixLength
    return {
      kind: 'function',
      name,
      nameStart,
      nameEnd: nameStart + name.length,
      signature: parseFunctionSignature(header, local, functionMatch)
    }
  }

  if (FUNCTION_PREFIX.test(header)) {
    return { kind: 'function', invalidSignature: true }
  }

  if (COMMAND_PREFIX.test(header)) {
    const nameMatch = /^command\s+(\S+)/i.exec(header)
    if (nameMatch !== null) {
      const name = nameMatch[1] ?? ''
      const nameStart = nameMatch.index + nameMatch[0].length - name.length
      return {
        kind: 'command',
        name,
        nameStart,
        nameEnd: nameStart + name.length
      }
    }
    return { kind: 'command' }
  }

  if (EVENT_PREFIX.test(header)) {
    return {
      kind: 'event',
      name: header,
      nameStart: 0,
      nameEnd: header.length
    }
  }

  if (SIMPLE_STRUCTURE.test(header)) {
    return { kind: 'unknown', simple: true }
  }

  return { kind: 'unknown' }
}

export function isSimpleStructureHeader(header: string): boolean {
  return SIMPLE_STRUCTURE.test(header)
}

/** `foo: bar` gibi üst düzey girdileri (string içindeki ':' hariç) tanır. */
export function findTopLevelColon(text: string): number {
  return findTopLevelCharacter(text, ':')
}
