import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkAddonSelections,
  DEFAULT_SKRIPT_VERSION,
  findRuntimeProfile,
  parseAddonSelections,
  SKRIPT_RUNTIMES,
  type AddonSelection
} from '@skript-ide/runtime-validator'
import { defineTool, ToolError } from '../../tool'

export const PROJECT_FILE_NAME = 'skript-project.json'

interface ProjectFile {
  /** Dosyanın durumu; kullanıcıya/LLM'e olduğu gibi gösterilir. */
  status: string
  skriptVersion?: string
  serverVersion?: string
  addons: AddonSelection[]
  warnings: string[]
}

async function readProjectFile(root: string): Promise<ProjectFile> {
  const result: ProjectFile = { status: 'found', addons: [], warnings: [] }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(root, PROJECT_FILE_NAME), 'utf8'))
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    result.status = missing ? 'not found (defaults are used)' : `invalid (${(error as Error).message}); defaults are used`
    return result
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    result.status = 'invalid (not a JSON object); defaults are used'
    return result
  }
  const fields = raw as Record<string, unknown>
  if (typeof fields.skriptVersion === 'string') result.skriptVersion = fields.skriptVersion
  if (typeof fields.serverVersion === 'string') result.serverVersion = fields.serverVersion
  const addons = parseAddonSelections(fields.addons)
  result.addons = addons.selections
  result.warnings.push(...addons.warnings)
  return result
}

export const getProjectInfoTool = defineTool<Record<string, never>>({
  name: 'get_project_info',
  description:
    `Show the project's Skript setup: ${PROJECT_FILE_NAME} (Skript version, server version, addons), ` +
    'which Skript versions the IDE supports, whether syntax data exists for each addon, addon compatibility ' +
    'problems, and the validation server state (including addons that failed to load).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permission: 'read',
  async execute(_input, ctx) {
    if (!ctx.projectRoot) throw new ToolError('No project folder is open.')
    const root = await realpath(ctx.projectRoot)
    const project = await readProjectFile(root)
    const lines = [`Project folder: ${root}`, `${PROJECT_FILE_NAME}: ${project.status}`]

    let skriptVersion = DEFAULT_SKRIPT_VERSION
    if (project.skriptVersion === undefined) {
      lines.push(`Skript version: ${DEFAULT_SKRIPT_VERSION} (default; "skriptVersion" is not set)`)
    } else if (!findRuntimeProfile(project.skriptVersion)) {
      lines.push(`Skript version: ${DEFAULT_SKRIPT_VERSION} (default; ${project.skriptVersion} is not supported)`)
    } else {
      skriptVersion = project.skriptVersion
      lines.push(`Skript version: ${skriptVersion}`)
    }
    const service = ctx.languageService
    if (service && service.skriptVersion !== skriptVersion) {
      lines.push(`Syntax data in use: Skript ${service.skriptVersion}`)
    }
    if (service?.versionWarning) lines.push(service.versionWarning.message)
    if (project.serverVersion) lines.push(`Server version: ${project.serverVersion}`)
    lines.push(
      `Supported Skript versions: ${SKRIPT_RUNTIMES.map((profile) => `${profile.skript} (Minecraft ${profile.minecraft})`).join(', ')}`
    )

    const dataStatus = new Map((service?.addonDataStatus() ?? []).map((status) => [status.name.toLowerCase(), status]))
    const status = ctx.server?.currentStatus
    const loaded = new Map((status?.addons ?? []).map((addon) => [addon.name.toLowerCase(), addon]))
    if (project.addons.length === 0) {
      lines.push('Addons: none')
    } else {
      lines.push('Addons:')
      for (const addon of project.addons) {
        const parts: string[] = []
        const data = dataStatus.get(addon.name.toLowerCase())
        if (data?.data === 'exact') parts.push('syntax data available')
        else if (data?.data === 'nearest') parts.push(`syntax data from Skript ${data.skriptVersion}`)
        else if (data) parts.push('no syntax data')
        const server = loaded.get(addon.name.toLowerCase())
        if (server) {
          const problems = server.problems?.length ? ` (${server.problems.join('; ')})` : ''
          const message = server.message ? `: ${server.message}` : ''
          parts.push(`server: ${server.state}${message}${problems}`)
        }
        lines.push(`- ${addon.name} ${addon.version}${parts.length ? ` — ${parts.join(', ')}` : ''}`)
      }
    }

    const issues = [...project.warnings, ...checkAddonSelections(project.addons, skriptVersion).map((issue) => issue.message)]
    if (issues.length > 0) lines.push('Problems:', ...issues.map((issue) => `- ${issue}`))
    if (status) lines.push(`Validation server: ${status.state} (${status.message})`)
    return lines.join('\n')
  }
})
