import { prepareServerCommand } from '@skript-ide/runtime-validator'
import { ToolError, type ToolContext } from '../../tool'

/** Tek seferde gönderilebilecek komut sayısı; `SkriptServer` de aynı sınırı uygular. */
export const MAX_SERVER_COMMANDS = 20

/** İptal edilince bekleme bırakılır; sunucudaki iş kendi zaman aşımıyla biter. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ToolError('Cancelled.'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ToolError('Cancelled.'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function requireServer(ctx: ToolContext): NonNullable<ToolContext['server']> {
  if (!ctx.server) throw new ToolError('The validation server is not available.')
  return ctx.server
}

/** Sunucuya iş göndermeden önce iptali denetler; `untilAborted` iş başladıktan sonra devreye girer. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolError('Cancelled.')
}

export async function requireEula(server: NonNullable<ToolContext['server']>): Promise<void> {
  if (!(await server.isEulaAccepted())) {
    throw new ToolError('The Minecraft EULA has not been accepted, so the test server cannot start. Ask the user to accept it in the Server panel.')
  }
}

/**
 * LLM'den gelen komutları doğrular: 1-20 tek satırlık komut, baştaki `/` atılır.
 * Sunucuyu durdurabilecek komutlar burada da reddedilir; asıl denetim `SkriptServer` tarafında.
 */
export function prepareCommands(commands: unknown): string[] {
  if (!Array.isArray(commands) || commands.length === 0) throw new ToolError('Give at least one console command.')
  if (commands.length > MAX_SERVER_COMMANDS) throw new ToolError(`Run at most ${MAX_SERVER_COMMANDS} commands at once.`)
  return commands.map((command, index) => {
    if (typeof command !== 'string') throw new ToolError(`Command ${index + 1} must be text.`)
    try {
      return prepareServerCommand(command)
    } catch {
      throw new ToolError(
        `Command ${index + 1} (${JSON.stringify(command)}) cannot be run on the test server: commands must be a single line, ` +
          'and stopping/restarting the server, Bukkit\'s reload, operator, whitelist and ban commands are rejected ' +
          '(Skript\'s own "sk reload" is allowed).'
      )
    }
  })
}

/** Yakalanan satırları LLM için kısaltır: son satırlar kalır, başta kaç satırın atlandığı yazılır. */
export function formatCapturedOutput(lines: readonly string[], maxLines = 200, maxChars = 8000): string {
  if (lines.length === 0) return '(no console output)'
  const shown = lines.slice(-maxLines)
  let text = shown.join('\n')
  let omitted = lines.length - shown.length
  if (text.length > maxChars) {
    const cut = text.slice(-maxChars)
    const newline = cut.indexOf('\n')
    text = newline >= 0 ? cut.slice(newline + 1) : cut
    omitted = lines.length - text.split('\n').length
  }
  return omitted > 0 ? `(${omitted} earlier lines omitted)\n${text}` : text
}

/**
 * Skript'in runtime hatalarını yakalayan satırlar. Doğrulama hataları `validate()` ile zaten gelir;
 * burada komutlar çalışırken konsola düşen exception ve stack satırları aranır.
 */
const RUNTIME_ERROR_PATTERNS: readonly RegExp[] = [
  /\b\w*(?:Exception|Error)\b/,
  /^\s*(?:at [\w$.<]+\(|Caused by:)/,
  /\bEncountered \d+ errors? while reloading\b/i,
  /\b(?:can't|cannot) (?:understand|find|load|parse)\b/i,
  /\berror (?:while|occurred while|when) (?:executing|running|loading)\b/i,
  /\bScript '.*' (?:could not be loaded|has failed)\b/i
]

export function isRuntimeError(line: string): boolean {
  return RUNTIME_ERROR_PATTERNS.some((pattern) => pattern.test(line))
}
