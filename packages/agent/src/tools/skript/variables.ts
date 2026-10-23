import type { StructureNode } from '@skript-ide/parser'
import { defineTool } from '../../tool'
import {
  clip,
  editDistance,
  maskNested,
  readProjectScripts,
  scanVariables,
  shapesOverlap,
  structureAt,
  structureLabel,
  variableShape,
  type ParsedScript
} from './script-scan'

const MAX_VARIABLES = 60
const MAX_SITES = 6
const MAX_ISSUES = 40

export type Access = 'write' | 'read'

export interface VariableSite {
  name: string
  shape: string
  local: boolean
  access: Access
  path: string
  /** 1 tabanlı. */
  line: number
  source: string
  /** `set {x} to …` ise atanan ifade. */
  value?: string
  structure?: StructureNode
}

const WRITE_STATEMENT = /^(set|add|remove|delete|clear|reset)\b/i

/**
 * Değişkenin bu satırda yazılıp yazılmadığı: `set X to …`, `add … to X`, `remove … from X`,
 * `delete/clear/reset X`. Adın içindeki değişkenler (`{a::%{_i}%}` içindeki `_i`) okunmuş sayılır.
 */
function accessOf(statement: string, start: number, nested: boolean): { access: Access; value?: string } {
  if (nested) return { access: 'read' }
  const keyword = WRITE_STATEMENT.exec(statement)?.[1].toLowerCase()
  if (!keyword) return { access: 'read' }
  const masked = maskNested(statement).toLowerCase()
  if (keyword === 'set') {
    const to = masked.indexOf(' to ')
    if (to === -1 || start < to) return { access: 'write', value: to === -1 ? undefined : statement.slice(to + 4).trim() }
    return { access: 'read' }
  }
  if (keyword === 'add' || keyword === 'remove') {
    const separator = keyword === 'add' ? ' to ' : ' from '
    const at = masked.lastIndexOf(separator)
    return { access: at !== -1 && start > at ? 'write' : 'read' }
  }
  return { access: 'write' }
}

/** Projedeki tüm değişken kullanımları; `variables:` yapısındaki varsayılanlar yazma sayılır. */
export function collectVariableSites(scripts: readonly ParsedScript[]): VariableSite[] {
  const sites: VariableSite[] = []
  for (const script of scripts) {
    for (const line of script.doc.lines) {
      if (line.blank) continue
      const structure = structureAt(script.doc, line.line)
      if (structure?.kind === 'options' || structure?.kind === 'aliases') continue
      const defaults = structure?.kind === 'variables' && line.line !== structure.range.start.line
      for (const variable of scanVariables(line.text)) {
        const local = variable.name.startsWith('_')
        const { access, value } = defaults ? { access: 'write' as const, value: undefined } : accessOf(line.text, variable.start, variable.nested)
        sites.push({
          name: variable.name,
          shape: variableShape(variable.name),
          local,
          access,
          path: script.path,
          line: line.line + 1,
          source: line.text,
          value,
          structure
        })
      }
    }
  }
  return sites
}

/** `coins::%` ve `coins::*` → `coins::*`; liste olmayan adlar olduğu gibi kalır. */
function listRoot(shape: string): string {
  const parts = shape.split('::')
  const dynamic = parts.findIndex((part) => part === '*' || part.includes('%'))
  return dynamic <= 0 ? shape : [...parts.slice(0, dynamic), '*'].join('::')
}

/** Fonksiyon parametreleri yerel değişken olarak yazılmış sayılır. */
function parameterShapes(script: ParsedScript, structure: StructureNode | undefined): string[] {
  if (structure?.kind !== 'function') return []
  const definition = script.doc.functions.find((fn) => fn.structure === structure)
  return (definition?.parameters ?? []).map((parameter) => `_${parameter.name.toLowerCase()}`)
}

interface VariablesInput {
  name?: string
  path?: string
  details?: boolean
}

export const inspectVariablesTool = defineTool<VariablesInput>({
  name: 'inspect_variables',
  description:
    'Map every Skript variable in the project: for each global variable (grouped by shape, so {coins::%player%} and ' +
    '{coins::%player\'s uuid%} are one entry) where it is set and where it is read, and what values are assigned. ' +
    'Also reports likely bugs: globals that are read but never set anywhere (often a typo, with the closest set name), ' +
    'globals that are set but never read, and local variables read in a trigger or function that never sets them. ' +
    'Run it before adding or renaming variables, and when a variable "is always empty".',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Only show variables whose name contains this text (case-insensitive), e.g. "coins".' },
      path: { type: 'string', description: 'Only show variables used in this .sk file (the whole project is still analysed).' },
      details: { type: 'boolean', description: 'List every set/read location instead of the first few.' }
    },
    additionalProperties: false
  },
  permission: 'read',
  async execute(input, ctx) {
    const { scripts } = await readProjectScripts(ctx)
    if (scripts.length === 0) return 'No .sk files in the project.'
    const sites = collectVariableSites(scripts)
    const filter = input.name?.trim().toLowerCase().replace(/^\{|\}$/g, '')
    const pathFilter = input.path?.replace(/\\/g, '/').replace(/^\.\//, '')
    const shown = (site: VariableSite) =>
      (!filter || site.name.toLowerCase().includes(filter)) && (!pathFilter || site.path === pathFilter)

    const globals = sites.filter((site) => !site.local)
    const writes = globals.filter((site) => site.access === 'write')
    const reads = globals.filter((site) => site.access === 'read')
    // Liste elemanları ve `::*` aynı listenin kökü altında toplanır
    const byShape = new Map<string, VariableSite[]>()
    for (const site of globals) {
      const root = listRoot(site.shape)
      if (!byShape.has(root)) byShape.set(root, [])
      byShape.get(root)!.push(site)
    }

    const out: string[] = []
    const visible = [...byShape.entries()].filter(([, list]) => list.some(shown)).sort(([a], [b]) => a.localeCompare(b))
    out.push(`Global variables: ${visible.length}${visible.length !== byShape.size ? ` of ${byShape.size}` : ''} (list elements are grouped under {list::*})`)
    const limit = input.details ? Infinity : MAX_SITES
    for (const [shape, list] of visible.slice(0, MAX_VARIABLES)) {
      const w = list.filter((site) => site.access === 'write')
      const r = list.filter((site) => site.access === 'read')
      const names = [...new Set(list.map((site) => `{${site.name}}`))]
      out.push(`- {${shape}}: set ${w.length}×, read ${r.length}×${names.length > 1 ? `; written as ${names.slice(0, 4).join(', ')}` : ''}`)
      const values = [...new Set(w.map((site) => site.value).filter((value): value is string => !!value))]
      if (values.length) out.push(`    values: ${values.slice(0, 5).map((value) => clip(value, 60)).join(' | ')}`)
      for (const site of [...w, ...r].slice(0, limit)) out.push(`    ${site.access === 'write' ? 'set ' : 'read'} ${site.path}:${site.line}: ${clip(site.source)}`)
      if (w.length + r.length > limit) out.push(`    (… ${w.length + r.length - limit} more; pass details=true)`)
    }
    if (visible.length > MAX_VARIABLES) out.push(`(… ${visible.length - MAX_VARIABLES} more; narrow with name)`)

    const issues: string[] = []
    const writtenShapes = [...new Set(writes.map((site) => site.shape))]
    const readShapes = [...new Set(reads.map((site) => site.shape))]
    for (const shape of readShapes) {
      if (writtenShapes.some((written) => shapesOverlap(shape, written))) continue
      const site = reads.find((s) => s.shape === shape)!
      if (!shown(site)) continue
      const near = writtenShapes
        .map((written) => ({ written, distance: editDistance(shape, written) }))
        .filter(({ distance }) => distance <= Math.max(2, Math.floor(shape.length / 6)))
        .sort((a, b) => a.distance - b.distance)[0]
      const example = near && writes.find((s) => s.shape === near.written)
      const hint = example ? `; did you mean {${example.name}}?` : ' (unless another plugin or skript-reflect sets it)'
      issues.push(`{${site.name}} is read at ${site.path}:${site.line} but never set anywhere${hint}`)
    }
    for (const shape of writtenShapes) {
      if (readShapes.some((read) => shapesOverlap(shape, read))) continue
      const site = writes.find((s) => s.shape === shape)!
      if (shown(site)) issues.push(`{${site.name}} is set at ${site.path}:${site.line} but never read (unused, or only used by another plugin)`)
    }

    // Yereller: aynı tetikleyicide hiç yazılmadan okunanlar
    for (const script of scripts) {
      const locals = sites.filter((site) => site.local && site.path === script.path)
      const groups = new Map<StructureNode | undefined, VariableSite[]>()
      for (const site of locals) {
        if (!groups.has(site.structure)) groups.set(site.structure, [])
        groups.get(site.structure)!.push(site)
      }
      for (const [structure, list] of groups) {
        const written = [...new Set(list.filter((site) => site.access === 'write').map((site) => site.shape)), ...parameterShapes(script, structure)]
        const reported = new Set<string>()
        for (const site of list) {
          if (site.access !== 'read' || reported.has(site.shape) || !shown(site)) continue
          if (written.some((shape) => shapesOverlap(site.shape, shape))) continue
          reported.add(site.shape)
          const near = written.find((shape) => editDistance(shape, site.shape) <= 2)
          issues.push(
            `{${site.name}} is read at ${site.path}:${site.line} in "${structureLabel(structure)}" but never set there` +
              (near ? `; did you mean {${near}}?` : '; locals do not carry over between triggers')
          )
        }
      }
    }

    if (issues.length) {
      out.push('', `Possible problems (${issues.length}):`, ...issues.slice(0, MAX_ISSUES).map((issue) => `- ${issue}`))
      if (issues.length > MAX_ISSUES) out.push(`(… ${issues.length - MAX_ISSUES} more)`)
    } else {
      out.push('', 'No unset or unused variables found.')
    }
    return out.join('\n')
  }
})
