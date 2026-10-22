import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { l } from '@skript-ide/i18n'
export const EULA_URL = 'https://aka.ms/MinecraftEULA'

export async function isEulaAccepted(serverDir: string): Promise<boolean> {
  try {
    const text = await readFile(join(serverDir, 'eula.txt'), 'utf8')
    return /^\s*eula\s*=\s*true\s*$/m.test(text)
  } catch {
    return false
  }
}

/**
 * Yalnızca kullanıcı EULA'yı arayüzde açıkça kabul ettikten sonra çağrılmalı.
 * Bu paket bunu kendiliğinden hiçbir zaman çağırmaz.
 */
export async function writeEulaAcceptance(serverDir: string): Promise<void> {
  const text = [
    l(`# ${EULA_URL} adresindeki Minecraft EULA'sı kullanıcı tarafından Skript IDE içinde kabul edildi.`, `# The Minecraft EULA at ${EULA_URL} was accepted by the user in Skript IDE.`),
    `# ${new Date().toISOString()}`,
    'eula=true',
    ''
  ].join('\n')
  await writeFile(join(serverDir, 'eula.txt'), text, 'utf8')
}
