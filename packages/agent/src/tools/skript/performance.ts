import type { BodyNode, StructureNode } from '@skript-ide/parser'
import { defineTool } from '../../tool'
import { clip, readProjectScripts, structureLabel } from './script-scan'

const MAX_FINDINGS = 60

type Severity = 'high' | 'medium' | 'low'

interface Finding {
  severity: Severity
  path: string
  line: number
  where: string
  message: string
  source: string
}

/** Sık tetiklenen olaylar: her hareket, her tick, her fizik güncellemesi… */
const FREQUENT_EVENT =
  /^on\s+(?:any\s+)?(?:player\s+|entity\s+)?(?:move|moving|walk|step(?:ping)?(?: on)?|(?:block\s+)?physics|redstone|(?:block\s+)?spread|(?:fluid\s+)?flow|grow|(?:server\s+)?tick|chunk\s+load|hopper|item\s+(?:move|transfer)|inventory\s+(?:move|item move)|entity\s+(?:target|pathfind)|player\s+(?:look|rotate)|armor\s+change|jump)/i

const TIME_UNITS: Record<string, number> = { tick: 1, second: 20, minute: 1200, hour: 72000, day: 1728000 }

/** `every 5 ticks`, `every 0.5 seconds`, `every tick`, `every second` → tick cinsinden aralık. */
export function periodTicks(header: string): number | null {
  const match = /^every\s+(?:(\d+(?:\.\d+)?|an?|one)\s+)?(?:real\s+|minecraft\s+|mc\s+)?(tick|second|minute|hour|day)s?\b/i.exec(header.trim())
  if (!match) return null
  const amount = match[1] === undefined || /^(?:an?|one)$/i.test(match[1]) ? 1 : Number(match[1])
  return amount * TIME_UNITS[match[2].toLowerCase()]
}

interface Scope {
  /** Kaç kez çalıştığına dair açıklama; sık değilse `null`. */
  frequent: string | null
  loops: string[]
}

function bodyHasWait(nodes: readonly BodyNode[]): boolean {
  return nodes.some((node) =>
    node.type === 'statement'
      ? /^wait\b/i.test(node.text)
      : node.type === 'section'
        ? bodyHasWait(node.children)
        : node.children
          ? bodyHasWait(node.children)
          : false
  )
}

function loopSize(header: string): number | null {
  const times = /^loop\s+(\d+)\s+times\b/i.exec(header)
  if (times) return Number(times[1])
  const range = /^loop\s+(?:all\s+)?(?:integers|numbers)\s+(?:between|from)\s+(-?\d+)\s+(?:and|to)\s+(-?\d+)/i.exec(header)
  if (range) return Number(range[2]) - Number(range[1]) + 1
  return null
}

function analyzeStructure(structure: StructureNode, path: string): Finding[] {
  const findings: Finding[] = []
  const where = structureLabel(structure)
  const header = structure.header.trim()
  const add = (severity: Severity, node: { range: { start: { line: number } } }, source: string, message: string) =>
    findings.push({ severity, path, line: node.range.start.line + 1, where, message, source })

  let frequent: string | null = null
  const period = periodTicks(header)
  if (period !== null) {
    if (period < 20) frequent = `runs ${period === 1 ? 'every tick (20×/s)' : `every ${period} ticks (${(20 / period).toFixed(1)}×/s)`}`
    if (period < 1) add('high', structure, header, 'Periods under one tick are not possible; Skript rounds them.')
  } else if (FREQUENT_EVENT.test(header)) {
    frequent = 'fires very often (many times per second per player or block)'
  }

  const visit = (nodes: readonly BodyNode[], scope: Scope) => {
    for (const node of nodes) {
      const text = (node.type === 'section' ? node.header : node.type === 'entry' ? `${node.key}: ${node.value}` : node.text).trim()
      const lower = text.toLowerCase()
      const inLoop = scope.loops.length > 0

      if (node.type === 'section' && /^loop\b/i.test(text)) {
        const waits = bodyHasWait(node.children)
        if (scope.frequent) add('high', node, text, `Loop inside code that ${scope.frequent}; move it to a slower trigger or cache the result.`)
        if (/\ball (?:the )?entities\b(?!\s+(?:in|within)\s+(?:a\s+)?radius)|\bentities in (?:all )?worlds?\b/i.test(text)) add(scope.frequent ? 'high' : 'medium', node, text, 'Looping all entities is expensive on busy servers; loop entities in radius or of a type instead.')
        if (/\ball (?:the )?(?:blocks|chunks)\b/i.test(text)) add('high', node, text, 'Looping all blocks/chunks can freeze the server.')
        const radius = /\bblocks?\s+(?:with)?in\s+(?:a\s+)?radius\s+(\d+)/i.exec(text)
        if (radius && Number(radius[1]) >= 10) {
          const count = Math.round((4 / 3) * Math.PI * Number(radius[1]) ** 3)
          add(Number(radius[1]) >= 20 ? 'high' : 'medium', node, text, `Radius ${radius[1]} is about ${count.toLocaleString('en-US')} blocks per run; use a smaller radius or spread the work with waits.`)
        }
        if (/\ball (?:the )?players\b/i.test(text) && scope.loops.some((loop) => /\ball (?:the )?players\b/i.test(loop))) {
          add('medium', node, text, 'Nested "loop all players" is players² iterations.')
        }
        const size = loopSize(text)
        if (size !== null && size >= 1000 && !waits) add(size >= 10000 ? 'high' : 'medium', node, text, `${size.toLocaleString('en-US')} iterations without a wait run in a single tick; split the work with "wait 1 tick" every few hundred iterations.`)
        if (/\{[^_@][^}]*::\*\}/.test(text) && scope.frequent) add('medium', node, text, 'Looping a global list in frequent code; large lists make this slow.')
        visit(node.children, { ...scope, loops: [...scope.loops, text] })
        continue
      }
      if (node.type === 'section' && /^while\b/i.test(text)) {
        if (!bodyHasWait(node.children)) add('high', node, text, 'A while loop without a wait blocks the server until it ends; make sure it always ends quickly or add "wait 1 tick".')
        visit(node.children, { ...scope, loops: [...scope.loops, text] })
        continue
      }
      if (node.type === 'statement') {
        if (scope.frequent || inLoop) {
          const context = scope.frequent ? `code that ${scope.frequent}` : 'a loop'
          if (/^(?:set|add|remove|delete|clear|reset)\b.*\{[^_@][^}]*\}/i.test(text) && scope.frequent) {
            add('medium', node, text, `Writes a global variable in ${context}; every change is queued for saving. Keep hot data in a local or a memory variable ({-name}, which Skript's default config does not save) or write less often.`)
          }
          if (/\b(?:execute|make)\b.*\bconsole\b.*\bcommand\b|^(?:execute|make)\s+console/i.test(lower)) add(scope.frequent ? 'medium' : 'low', node, text, `Runs a console command in ${context}; call the Skript effect directly if one exists.`)
          if (/\b(?:size|amount|number) of (?:all )?\{[^_@][^}]*::\*\}/i.test(text) && scope.frequent) add('low', node, text, `Counts a global list in ${context}; keep a counter variable instead for large lists.`)
          if (/\b(?:save|load)\s+(?:the\s+)?(?:yaml|json|config|file)\b|\bdownload\b|\bsql\b|\bquery\b/i.test(lower) && scope.frequent) add('high', node, text, `File/database/network work in ${context}; do it rarely and cache the result.`)
        }
        if (/\b(?:all (?:the )?entities|entities in (?:all )?worlds?)\b/i.test(text) && !/^loop\b/i.test(text) && scope.frequent) {
          add('medium', node, text, 'Collects all entities in frequent code.')
        }
      }
      if (node.type === 'section') visit(node.children, scope)
      else if (node.type === 'entry' && node.children) visit(node.children, scope)
    }
  }
  visit(structure.children, { frequent, loops: [] })
  return findings
}

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

export const analyzePerformanceTool = defineTool<{ path?: string }>({
  name: 'analyze_performance',
  description:
    'Statically check Skript code for patterns that cause lag: loops and heavy work inside events that fire very ' +
    'often (move, physics, redstone, "every tick"/short periodicals), looping all entities or large block radii, huge ' +
    'loops without waits, while loops that never wait, nested player loops, global variable writes, console commands ' +
    'and file/database work in hot code. Each finding has a severity, location and suggested fix. ' +
    'Use it when the user mentions lag or TPS, and before shipping code that runs in frequent events.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'A .sk file relative to the project root; default: every .sk file.' } },
    additionalProperties: false
  },
  permission: 'read',
  async execute({ path }, ctx) {
    const { scripts } = await readProjectScripts(ctx, path)
    if (scripts.length === 0) return 'No .sk files in the project.'
    const findings = scripts
      .flatMap((script) => script.doc.structures.flatMap((structure) => analyzeStructure(structure, script.path)))
      .sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.path.localeCompare(b.path) || a.line - b.line)
    if (findings.length === 0) return `No performance problems found in ${scripts.length} file${scripts.length === 1 ? '' : 's'}. (Static check only; it cannot measure real timings.)`
    const counts = (['high', 'medium', 'low'] as const).map((severity) => `${findings.filter((f) => f.severity === severity).length} ${severity}`).join(', ')
    const out = [`${findings.length} findings (${counts}):`]
    for (const finding of findings.slice(0, MAX_FINDINGS)) {
      out.push(`- [${finding.severity}] ${finding.path}:${finding.line} in ${finding.where}: ${finding.message}\n    ${clip(finding.source)}`)
    }
    if (findings.length > MAX_FINDINGS) out.push(`(… ${findings.length - MAX_FINDINGS} more; pass path to check one file)`)
    return out.join('\n')
  }
})
