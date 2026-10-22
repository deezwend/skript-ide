import { ProposedFeatures, createConnection } from 'vscode-languageserver/node'
import { readAddonDatabase, readSyntaxDatabase } from '@skript-ide/syntax-db/node'
import { startServer } from './server'

function ensureStdio(): void {
  const args = process.argv.slice(2)
  const hasTransport = args.some(
    (argument) =>
      argument === '--stdio' ||
      argument === '--node-ipc' ||
      argument.startsWith('--socket=') ||
      argument.startsWith('--pipe=')
  )
  if (!hasTransport) process.argv.push('--stdio')
}

/** Node/stdio taşıması: VS Code eklentisi ya da alt süreç olarak çalıştırma. */
export function startNodeServer(): void {
  ensureStdio()
  const connection = createConnection(ProposedFeatures.all)
  startServer(connection, { loadDatabase: readSyntaxDatabase, loadAddonDatabase: readAddonDatabase })
  connection.listen()
}
