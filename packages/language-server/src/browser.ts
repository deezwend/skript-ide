import { BrowserMessageReader, BrowserMessageWriter, createConnection } from 'vscode-languageserver/browser'
import { loadSyntaxDatabase } from '@skript-ide/syntax-db'
import { startServer } from './server'

/**
 * Monaco'nun module Web Worker'ı içinde çalışan giriş. `self` (worker global kapsamı) üzerinden
 * mesajlaşır; syntax veritabanı Vite'ın parçalı JSON yükleyicisiyle getirilir.
 */
export function startBrowserServer(): void {
  const scope = globalThis as unknown as ConstructorParameters<typeof BrowserMessageReader>[0]
  const connection = createConnection(new BrowserMessageReader(scope), new BrowserMessageWriter(scope))
  startServer(connection, { loadDatabase: loadSyntaxDatabase })
  connection.listen()
}
