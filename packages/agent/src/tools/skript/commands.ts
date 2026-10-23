import type { StructureNode } from '@skript-ide/parser'
import { defineTool } from '../../tool'
import { readProjectScripts } from './script-scan'

const VANILLA = new Set(
  (
    'advancement attribute ban ban-ip banlist bossbar clear clone damage data datapack debug defaultgamemode deop difficulty ' +
    'effect enchant execute experience xp fill fillbiome forceload function gamemode gamerule give help item jfr kick kill list ' +
    'locate loot me msg tell w op pardon pardon-ip particle place playsound publish random recipe reload return ride rotate ' +
    'save-all save-off save-on say schedule scoreboard seed setblock setidletimeout setworldspawn spawnpoint spectate ' +
    'spreadplayers stop stopsound summon tag team teammsg tm teleport tp tellraw test tick time title transfer trigger weather ' +
    'whitelist worldborder plugins pl version ver about icanhasbukkit paper spigot restart timings mspt skript sk'
  ).split(' ')
)

const ESSENTIALS = new Set(
  (
    'home homes sethome delhome spawn setspawn warp warps setwarp delwarp tpa tpaccept tpdeny tpahere tphere back fly heal feed ' +
    'gm gmc gms gma gmsp god vanish v nick balance bal pay eco baltop kit kits afk repair hat invsee enderchest ec workbench ' +
    'craft top jump broadcast bc mail r reply ignore seen whois near speed sudo kickall tempban mute unmute jail sell worth'
  ).split(' ')
)

interface CommandInfo {
  name: string
  args: string
  path: string
  line: number
  entries: Map<string, string>
  aliases: string[]
}

function commandInfo(structure: StructureNode, path: string): CommandInfo {
  const header = structure.header.replace(/^command\s+/i, '').trim()
  const [rawName, ...rest] = header.split(/\s+/)
  const name = rawName.replace(/^\//, '').toLowerCase()
  const entries = new Map<string, string>()
  for (const child of structure.children) {
    if (child.type === 'entry') entries.set(child.key.trim().toLowerCase(), child.value.trim())
  }
  const aliases = (entries.get('aliases') ?? '')
    .split(/,|\band\b/)
    .map((alias) => alias.trim().replace(/^\//, '').toLowerCase())
    .filter(Boolean)
  return { name, args: rest.join(' '), path, line: structure.range.start.line + 1, entries, aliases }
}

export const listCommandsTool = defineTool<{ name?: string }>({
  name: 'list_commands',
  description:
    'List every command the project\'s scripts define, with arguments, permission, aliases, executable by, cooldown ' +
    'and usage, and where it is defined. Reports conflicts: the same command or alias defined in two places, ' +
    'commands that override Minecraft/Bukkit/Skript commands, and names commonly taken by EssentialsX. ' +
    'Also flags commands without a trigger. Use it before adding a command or when a command "does nothing".',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Only commands whose name or alias contains this text.' } },
    additionalProperties: false
  },
  permission: 'read',
  async execute(input, ctx) {
    const { scripts } = await readProjectScripts(ctx)
    const commands = scripts.flatMap((script) =>
      script.doc.structures.filter((structure) => structure.kind === 'command').map((structure) => commandInfo(structure, script.path))
    )
    if (commands.length === 0) return 'The project defines no commands.'
    const filter = input.name?.trim().replace(/^\//, '').toLowerCase()
    const shown = commands.filter((command) => !filter || command.name.includes(filter) || command.aliases.some((alias) => alias.includes(filter)))

    const out = [`${commands.length} command${commands.length === 1 ? '' : 's'}${filter ? `, ${shown.length} matching` : ''}:`]
    for (const command of shown) {
      out.push(`- /${command.name}${command.args ? ` ${command.args}` : ''} — ${command.path}:${command.line}`)
      const details: string[] = []
      for (const key of ['permission', 'aliases', 'executable by', 'cooldown', 'usage', 'description']) {
        const value = command.entries.get(key)
        if (value) details.push(`${key}: ${value}`)
      }
      if (details.length) out.push(`    ${details.join('; ')}`)
    }

    const issues: string[] = []
    const owners = new Map<string, CommandInfo[]>()
    for (const command of commands) {
      for (const label of [command.name, ...command.aliases]) {
        if (!owners.has(label)) owners.set(label, [])
        owners.get(label)!.push(command)
      }
    }
    for (const [label, list] of owners) {
      if (list.length > 1) issues.push(`/${label} is defined or aliased ${list.length} times: ${list.map((c) => `/${c.name} at ${c.path}:${c.line}`).join(', ')}; only one wins`)
    }
    for (const command of commands) {
      for (const label of [command.name, ...command.aliases]) {
        if (VANILLA.has(label)) issues.push(`/${label} (${command.path}:${command.line}) overrides a Minecraft, Bukkit or Skript command`)
        else if (ESSENTIALS.has(label)) issues.push(`/${label} (${command.path}:${command.line}) is also an EssentialsX command; on servers with EssentialsX one of them is shadowed`)
      }
      if (!command.entries.has('trigger')) issues.push(`/${command.name} (${command.path}:${command.line}) has no trigger: section`)
      if (/^console$/i.test(command.entries.get('executable by') ?? '') && command.entries.has('permission')) {
        issues.push(`/${command.name} (${command.path}:${command.line}) is console-only, so its permission has no effect`)
      }
    }
    out.push('', issues.length ? `Problems (${issues.length}):` : 'No command conflicts found.', ...issues.map((issue) => `- ${issue}`))
    return out.join('\n')
  }
})
