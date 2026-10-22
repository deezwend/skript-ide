import { Location, type Position } from 'vscode-languageserver'
import type { FunctionDefinition, SkriptDocument } from './contracts'
import { identifierAt, containsPosition } from './util'

export interface NavigationFile {
  uri: string
  key: string
  doc: SkriptDocument
}

export interface WorkspaceFunction {
  uri: string
  fileKey: string
  definition: FunctionDefinition
}

export interface NavigationInput {
  uri: string
  key: string
  doc: SkriptDocument
  text: string
  position: Position
  files: readonly NavigationFile[]
  functions: readonly WorkspaceFunction[]
}

interface RenameTarget {
  kind: 'function' | 'option'
  name: string
  range: import('./contracts').Range
  definition?: FunctionDefinition
}

function functionTarget(input: NavigationInput): RenameTarget | null {
  const { doc, position } = input
  for (const reference of doc.optionReferences) {
    if (containsPosition(reference.range, position)) {
      return { kind: 'option', name: reference.name, range: reference.range }
    }
  }
  for (const option of doc.options) {
    if (containsPosition(option.nameRange, position)) {
      return { kind: 'option', name: option.name, range: option.nameRange }
    }
  }
  for (const call of doc.functionCalls) {
    if (containsPosition(call.nameRange, position)) {
      return { kind: 'function', name: call.name, range: call.nameRange }
    }
  }
  for (const definition of doc.functions) {
    if (containsPosition(definition.nameRange, position)) {
      return { kind: 'function', name: definition.name, range: definition.nameRange, definition }
    }
  }

  // İmleç bir adın hemen yanındaysa (ör. boşlukta) tanımlayıcıyı dene.
  const token = identifierAt(input.text, position)
  if (token) {
    const lower = token.name.toLowerCase()
    if (doc.functionCalls.some((call) => call.name.toLowerCase() === lower)) {
      return { kind: 'function', name: token.name, range: token.range }
    }
    const definition = doc.functions.find((candidate) => candidate.name.toLowerCase() === lower)
    if (definition) {
      return { kind: 'function', name: definition.name, range: definition.nameRange, definition }
    }
    const option = doc.options.find((candidate) => candidate.name.toLowerCase() === lower)
    if (option) return { kind: 'option', name: option.name, range: option.nameRange }
  }
  return null
}

function visibleDefinitions(input: NavigationInput, name: string): WorkspaceFunction[] {
  const lower = name.toLowerCase()
  return input.functions.filter(
    (candidate) =>
      candidate.definition.name.toLowerCase() === lower &&
      (!candidate.definition.local || candidate.fileKey === input.key)
  )
}

export function computeDefinition(input: NavigationInput): Location[] {
  const target = functionTarget(input)
  if (!target) return []

  if (target.kind === 'option') {
    const lower = target.name.toLowerCase()
    return input.doc.options
      .filter((option) => option.name.toLowerCase() === lower)
      .map((option) => Location.create(input.uri, option.nameRange))
  }

  const definitions = visibleDefinitions(input, target.name)
  if (definitions.length > 0) {
    return definitions.map((candidate) => Location.create(candidate.uri, candidate.definition.nameRange))
  }
  return []
}

export function computeReferences(
  input: NavigationInput,
  includeDeclaration: boolean
): Location[] {
  const target = functionTarget(input)
  if (!target) return []
  const lower = target.name.toLowerCase()

  if (target.kind === 'option') {
    const locations: Location[] = []
    if (includeDeclaration) {
      for (const option of input.doc.options) {
        if (option.name.toLowerCase() === lower) locations.push(Location.create(input.uri, option.nameRange))
      }
    }
    for (const reference of input.doc.optionReferences) {
      if (reference.name.toLowerCase() === lower) locations.push(Location.create(input.uri, reference.range))
    }
    return sortLocations(locations)
  }

  const definitions = visibleDefinitions(input, target.name)
  const localDefinition = definitions.some((candidate) => candidate.definition.local)
  const restrictToFile = target.definition?.local === true || localDefinition
  const locations: Location[] = []

  if (includeDeclaration) {
    for (const candidate of definitions) {
      if (restrictToFile && candidate.fileKey !== input.key) continue
      locations.push(Location.create(candidate.uri, candidate.definition.nameRange))
    }
  }

  for (const file of input.files) {
    if (restrictToFile && file.key !== input.key) continue
    for (const call of file.doc.functionCalls) {
      if (call.name.toLowerCase() !== lower) continue
      locations.push(Location.create(file.uri, call.nameRange))
    }
  }

  return sortLocations(dedupe(locations))
}

function dedupe(locations: Location[]): Location[] {
  const seen = new Set<string>()
  return locations.filter((location) => {
    const key = `${location.uri}|${location.range.start.line}:${location.range.start.character}|${location.range.end.character}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sortLocations(locations: Location[]): Location[] {
  return locations.sort(
    (left, right) =>
      left.uri.localeCompare(right.uri) ||
      left.range.start.line - right.range.start.line ||
      left.range.start.character - right.range.start.character
  )
}
