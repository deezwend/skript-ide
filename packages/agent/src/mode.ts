/**
 * Agent'ın ne kadar derin çalıştığı:
 * - `quick`: istenen küçük değişikliği yapar; sunucu, test, örnek ve plan tool'ları kapalıdır.
 * - `standard`: varsayılan; değişikliği yapar, gerekirse dosyayı denetler.
 * - `thorough`: değişikliği sunucuda doğrular ve test eder.
 *
 * Mod sistem istemini ve tool listesini değiştirir; önbellek bozulmasın diye konuşma başladıktan
 * sonra değiştirilmez.
 */
export type AgentMode = 'quick' | 'standard' | 'thorough'

export const AGENT_MODES: readonly AgentMode[] = ['quick', 'standard', 'thorough']

export const DEFAULT_AGENT_MODE: AgentMode = 'standard'

export function isAgentMode(value: unknown): value is AgentMode {
  return AGENT_MODES.includes(value as AgentMode)
}

/** `quick` modda modele hiç gösterilmeyen tool'lar. */
const QUICK_EXCLUDED_TOOLS = new Set([
  'validate_on_server',
  'test_script',
  'run_server_command',
  'get_server_log',
  'search_examples',
  'get_migration_notes',
  'update_todos',
  'list_models',
  'run_subagent'
])

export function toolAllowedInMode(mode: AgentMode, toolName: string): boolean {
  return mode !== 'quick' || !QUICK_EXCLUDED_TOOLS.has(toolName)
}

/** Her modda geçerli kapsam kuralları; modun derinliği değişir, istenenin dışına çıkmama kuralı değişmez. */
export const SCOPE_INSTRUCTIONS = [
  '- Do exactly what the user asked, nothing more. A small request gets a small change.',
  '- Do not add features, commands, options, permissions, cooldowns, messages, config or error handling the user did not ask for. Do not refactor, rename or reformat code you were not asked to touch.',
  '- Prefer the simplest Skript that works; do not introduce functions, options blocks or global variables for one-off logic.',
  '- The Skript guide lists pitfalls to avoid, not a checklist of things to add.',
  '- If you think something extra would help, mention it in one sentence at the end instead of doing it.',
  '- When the user only asks a question, answer it; do not edit files unless asked.'
].join('\n')

export function modeInstructions(mode: AgentMode): string {
  switch (mode) {
    case 'quick':
      return [
        'Quick mode: the user wants fast, minimal answers.',
        '- Make the change with as few tool calls as possible: read only what you need, edit, stop.',
        '- The automatic feedback after an edit is enough; call get_diagnostics only if that feedback reports a problem you cannot fix from it.',
        '- Look up syntax only when you are genuinely unsure it exists.',
        '- Server, test, example, migration and todo tools are not available in this mode. If the user needs runtime proof, tell them to start a new conversation in Standard or Thorough mode.',
        '- Keep replies to a few sentences.'
      ].join('\n')
    case 'standard':
      return [
        'Standard mode.',
        '- For a one-line or otherwise trivial fix, the automatic feedback after an edit is enough.',
        '- Use validate_on_server, test_script and search_examples only when the change is non-trivial or the user asks for proof.'
      ].join('\n')
    case 'thorough':
      return [
        'Thorough mode: the user wants verified, working results.',
        '- After changing a .sk file, check it with get_diagnostics, then confirm it loads with validate_on_server.',
        '- When the change has runtime behavior that the console can exercise, prove it with test_script.',
        '- Thorough means more verification, not more features: the scope rules above still apply.',
        '- End with a short summary of what you changed and how you verified it.'
      ].join('\n')
  }
}
