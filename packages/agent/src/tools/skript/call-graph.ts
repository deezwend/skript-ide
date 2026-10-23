import type { FunctionDefinition, StructureNode } from '@skript-ide/parser'
import { defineTool, ToolError, type AgentLanguageService, type AgentTool } from '../../tool'
import { clip, readProjectScripts, splitTopLevel, structureAt, structureLabel, type ParsedScript } from './script-scan'
import type { ProjectSyntax } from './syntax'

const MAX_ISSUES = 50
const MAX_FUNCTIONS = 80

interface Definition {
  fn: FunctionDefinition
  path: string
  line: number
}

interface Call {
  name: string
  path: string
  line: number
  args: number
  source: string
  /** Çağrının bulunduğu yapı; fonksiyon içindeyse fonksiyonun adı. */
  caller: string
  callerFunction?: string
  structure?: StructureNode
}

function argumentCount(lineText: string, start: number): number {
  const open = lineText.indexOf('(', start)
  if (open === -1) return 0
  let depth = 0
  let inString = false
  for (let i = open; i < lineText.length; i++) {
    const ch = lineText[i]
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return splitTopLevel(lineText.slice(open + 1, i)).length
  }
  return splitTopLevel(lineText.slice(open + 1)).length
}

/** Çoğul tür (`texts`, `players`) birden çok argümanı tek parametrede toplayabilir. */
function isPlural(type: string): boolean {
  return /s$/i.test(type.trim()) && !/(?:class|ss)$/i.test(type.trim())
}

export function collectCalls(scripts: readonly ParsedScript[]): { definitions: Definition[]; calls: Call[] } {
  const definitions: Definition[] = []
  const calls: Call[] = []
  for (const script of scripts) {
    for (const fn of script.doc.functions) definitions.push({ fn, path: script.path, line: fn.nameRange.start.line + 1 })
    for (const call of script.doc.functionCalls) {
      const line = call.nameRange.start.line
      const lineInfo = script.doc.lines[line]
      const text = lineInfo?.text ?? ''
      const structure = structureAt(script.doc, line)
      const callerFunction = structure?.kind === 'function' ? script.doc.functions.find((fn) => fn.structure === structure)?.name : undefined
      calls.push({
        name: call.name,
        path: script.path,
        line: line + 1,
        args: argumentCount(text, call.nameRange.end.character - (lineInfo?.start ?? 0)),
        source: text,
        caller: structureLabel(structure),
        callerFunction,
        structure
      })
    }
  }
  return { definitions, calls }
}

/** Fonksiyonların döngüsel çağrıları (özyineleme dahil). */
function cycles(edges: Map<string, Set<string>>): string[][] {
  const found: string[][] = []
  const seen = new Set<string>()
  const visit = (node: string, path: string[]) => {
    if (path.includes(node)) {
      const cycle = path.slice(path.indexOf(node))
      const key = [...cycle].sort().join(',')
      if (!seen.has(key)) {
        seen.add(key)
        found.push([...cycle, node])
      }
      return
    }
    if (path.length > 20) return
    for (const next of edges.get(node) ?? []) visit(next, [...path, node])
  }
  for (const node of edges.keys()) visit(node, [])
  return found
}

function hasWait(structure: StructureNode, script: ParsedScript): number | null {
  for (let line = structure.range.start.line + 1; line <= structure.range.end.line; line++) {
    const text = script.doc.lines[line]?.text ?? ''
    if (/^wait\b/i.test(text)) return line + 1
  }
  return null
}

interface CallGraphInput {
  function?: string
}

export function createCallGraphTool(projectSyntax: (service: AgentLanguageService) => Promise<ProjectSyntax>): AgentTool {
  return defineTool<CallGraphInput>({
    name: 'get_call_graph',
    description:
      'Map Skript functions across the whole project: where each function is defined, which triggers and functions ' +
      'call it and what it calls. Reports problems: calls to functions that do not exist (and are not built-in), ' +
      'calls with too few or too many arguments, local functions called from another file, functions defined twice, ' +
      'unused functions, recursion cycles, and `wait` inside functions that return a value. Pass function to see one ' +
      'function\'s signature, callers and callees.',
    inputSchema: {
      type: 'object',
      properties: { function: { type: 'string', description: 'A function name, e.g. "give_kit".' } },
      additionalProperties: false
    },
    permission: 'read',
    async execute(input, ctx) {
      const { scripts } = await readProjectScripts(ctx)
      if (scripts.length === 0) return 'No .sk files in the project.'
      const { definitions, calls } = collectCalls(scripts)
      let builtins = new Set<string>()
      if (ctx.languageService) {
        try {
          const syntax = await projectSyntax(ctx.languageService)
          builtins = new Set(syntax.index.database.entries.filter((entry) => entry.kind === 'function').map((entry) => entry.id.toLowerCase()))
        } catch {
          // Syntax verisi yoksa yerleşik fonksiyonlar bilinmez
        }
      }
      const byName = new Map<string, Definition[]>()
      for (const definition of definitions) {
        const key = definition.fn.name.toLowerCase()
        if (!byName.has(key)) byName.set(key, [])
        byName.get(key)!.push(definition)
      }
      const signature = ({ fn }: Definition) =>
        `${fn.local ? 'local ' : ''}function ${fn.name}(${fn.parameters.map((p) => `${p.name}: ${p.type}${p.defaultValue !== undefined ? ` = ${p.defaultValue}` : ''}`).join(', ')})${fn.returnType ? ` :: ${fn.returnType}` : ''}`

      if (input.function) {
        const name = input.function.trim().replace(/\(.*$/, '').toLowerCase()
        const defs = byName.get(name)
        const callers = calls.filter((call) => call.name.toLowerCase() === name)
        if (!defs && callers.length === 0) throw new ToolError(`No function named ${input.function} is defined or called in the project.`)
        const out: string[] = []
        if (defs) for (const def of defs) out.push(`${signature(def)}  — ${def.path}:${def.line}`)
        else out.push(`${input.function} is not defined in the project${builtins.has(name) ? ' (it is a built-in Skript function)' : ''}.`)
        out.push('', `Called from (${callers.length}):`, ...callers.map((call) => `- ${call.path}:${call.line} in ${call.caller}: ${clip(call.source)}`))
        const callees = defs ? calls.filter((call) => defs.some((def) => call.structure === def.fn.structure)) : []
        out.push('', `Calls (${callees.length}):`, ...callees.map((call) => `- ${call.name} at ${call.path}:${call.line}`))
        return out.join('\n')
      }

      const issues: string[] = []
      for (const [name, defs] of byName) {
        const globals = defs.filter((def) => !def.fn.local)
        if (globals.length > 1) issues.push(`function ${defs[0].fn.name} is defined ${globals.length} times: ${globals.map((d) => `${d.path}:${d.line}`).join(', ')}`)
        if (!calls.some((call) => call.name.toLowerCase() === name)) {
          issues.push(`function ${defs[0].fn.name} (${defs[0].path}:${defs[0].line}) is never called in the project`)
        }
        for (const def of defs) {
          if (!def.fn.returnType) continue
          const script = scripts.find((s) => s.path === def.path)!
          const wait = hasWait(def.fn.structure, script)
          if (wait) issues.push(`function ${def.fn.name} returns a value but waits at ${def.path}:${wait}; the caller gets nothing`)
        }
      }
      for (const call of calls) {
        const key = call.name.toLowerCase()
        const defs = byName.get(key)
        if (!defs) {
          if (!builtins.has(key)) issues.push(`${call.path}:${call.line}: ${call.name}() is not defined in the project and is not a built-in function`)
          continue
        }
        const visible = defs.filter((def) => !def.fn.local || def.path === call.path)
        if (visible.length === 0) {
          issues.push(`${call.path}:${call.line}: ${call.name}() is a local function of ${defs[0].path} and cannot be called from this file`)
          continue
        }
        const { fn } = visible[0]
        const required = fn.parameters.filter((p) => p.defaultValue === undefined).length
        const max = fn.parameters.length
        if (call.args < required) {
          issues.push(`${call.path}:${call.line}: ${fn.name}() needs at least ${required} argument${required === 1 ? '' : 's'} but gets ${call.args}`)
        } else if (call.args > max && max !== 1 && !fn.parameters.some((p) => isPlural(p.type))) {
          issues.push(`${call.path}:${call.line}: ${fn.name}() takes ${max} argument${max === 1 ? '' : 's'} but gets ${call.args}`)
        }
      }
      const edges = new Map<string, Set<string>>()
      for (const call of calls) {
        if (!call.callerFunction) continue
        const from = call.callerFunction.toLowerCase()
        if (!edges.has(from)) edges.set(from, new Set())
        if (byName.has(call.name.toLowerCase())) edges.get(from)!.add(call.name.toLowerCase())
      }
      for (const cycle of cycles(edges)) issues.push(`recursion: ${cycle.join(' → ')} (make sure it has a stopping condition)`)

      const out = [`${definitions.length} functions, ${calls.length} calls in ${scripts.length} files.`]
      for (const def of definitions.slice(0, MAX_FUNCTIONS)) {
        const callers = calls.filter((call) => call.name.toLowerCase() === def.fn.name.toLowerCase())
        const from = [...new Set(callers.map((call) => call.caller))]
        out.push(`- ${signature(def)} — ${def.path}:${def.line}; called ${callers.length}× from ${from.length ? from.slice(0, 5).join(', ') : 'nowhere'}${from.length > 5 ? ', …' : ''}`)
      }
      if (definitions.length > MAX_FUNCTIONS) out.push(`(… ${definitions.length - MAX_FUNCTIONS} more; pass function to see one)`)
      if (issues.length) {
        out.push('', `Problems (${issues.length}):`, ...issues.slice(0, MAX_ISSUES).map((issue) => `- ${issue}`))
        if (issues.length > MAX_ISSUES) out.push(`(… ${issues.length - MAX_ISSUES} more)`)
      } else {
        out.push('', 'No function problems found.')
      }
      return out.join('\n')
    }
  })
}
