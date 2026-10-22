/**
 * Uçtan uca: gerçek `src/bin.ts` süreci stdio üzerinden başlatılır; initialize → didOpen →
 * publishDiagnostics → completion/hover akışı ve dinamik yetenek kaydı sınanır.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection
} from 'vscode-jsonrpc/node'
import type { InitializeResult } from 'vscode-languageserver'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const binPath = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const URI = 'file:///e2e/test.sk'
const TEXT = [
  'options:',
  '    isim: Merhaba',
  '',
  'on join:',
  '    send "{@isim}" to player',
  '    bilinmeyenFonksiyonE2E(1)',
  '    se'
].join('\n')

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} zaman aşımına uğradı (${ms} ms)`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve()
    }, ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

test('stdio uçtan uca: tanı, tamamlama, hover ve dinamik kayıt', { timeout: 60_000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', binPath, '--stdio'], {
    cwd: packageRoot,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin)
  )

  const registrations: { method: string; registerOptions?: { documentSelector?: { language?: string }[] } }[] = []
  let resolveRegistration: (() => void) | undefined
  const registrationReceived = new Promise<void>((resolve) => {
    resolveRegistration = resolve
  })

  const diagnosticWaiters: ((params: unknown) => void)[] = []
  const nextDiagnostics = (): Promise<unknown> =>
    new Promise((resolve) => {
      diagnosticWaiters.push(resolve)
    })
  connection.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
    const value = params as { uri?: string }
    if (value.uri?.toLowerCase() !== URI) return
    diagnosticWaiters.shift()?.(params)
  })

  connection.onRequest('client/registerCapability', (params: unknown) => {
    const value = params as { registrations?: typeof registrations }
    if (value.registrations) registrations.push(...value.registrations)
    resolveRegistration?.()
    return null
  })

  connection.listen()

  try {
    const initialize = await timeout(
      connection.sendRequest<InitializeResult>('initialize', {
        processId: process.pid,
        rootUri: null,
        capabilities: {
          textDocument: {
            completion: { dynamicRegistration: true },
            hover: { dynamicRegistration: true },
            definition: { dynamicRegistration: true },
            references: { dynamicRegistration: true },
            documentSymbol: { dynamicRegistration: true },
            semanticTokens: { dynamicRegistration: true }
          }
        },
        initializationOptions: { skriptVersion: '2.17.1' }
      }),
      20_000,
      'initialize'
    )
    assert.equal(initialize.serverInfo?.name, 'skript-language-server')
    assert.ok(initialize.capabilities.textDocumentSync !== undefined)

    connection.sendNotification('initialized', {})

    await timeout(registrationReceived, 10_000, 'client/registerCapability')
    const completionRegistration = registrations.find(
      (registration) => registration.method === 'textDocument/completion'
    )
    assert.ok(completionRegistration, registrations.map((registration) => registration.method).join(','))
    assert.deepEqual(completionRegistration?.registerOptions?.documentSelector, [{ language: 'skript' }])
    assert.ok(registrations.some((registration) => registration.method === 'textDocument/semanticTokens/full'))

    connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri: URI, languageId: 'skript', version: 1, text: TEXT }
    })

    const published = (await timeout(nextDiagnostics(), 20_000, 'publishDiagnostics')) as {
      diagnostics: { code?: unknown; source?: string; message: string }[]
    }
    const codes = published.diagnostics.map((diagnostic) => String(diagnostic.code))
    assert.ok(codes.includes('undefined-function'), codes.join(','))
    assert.ok(
      published.diagnostics.every((diagnostic) => diagnostic.source === 'skript-ls'),
      JSON.stringify(published.diagnostics)
    )

    // Çalışma alanı bildirimi: fonksiyon başka bir dosyada tanımlanınca uyarı kaybolmalı.
    const workspace = nextDiagnostics()
    connection.sendNotification('skript/workspaceFiles', {
      files: [
        {
          uri: 'file:///e2e/lib.sk',
          text: ['function bilinmeyenFonksiyonE2E() :: number:', '\treturn 1'].join('\n')
        }
      ],
      complete: true
    })
    const withWorkspace = (await timeout(workspace, 20_000, 'workspaceFiles diagnostics')) as {
      diagnostics: { code?: unknown }[]
    }
    assert.ok(
      !withWorkspace.diagnostics.some((diagnostic) => String(diagnostic.code) === 'undefined-function'),
      JSON.stringify(withWorkspace.diagnostics)
    )

    // Dosya silinince uyarı geri gelmeli.
    const removed = nextDiagnostics()
    connection.sendNotification('skript/workspaceFileChanged', {
      uri: 'file:///e2e/lib.sk',
      text: null
    })
    const afterRemoval = (await timeout(removed, 20_000, 'workspaceFileChanged diagnostics')) as {
      diagnostics: { code?: unknown }[]
    }
    assert.ok(
      afterRemoval.diagnostics.some((diagnostic) => String(diagnostic.code) === 'undefined-function'),
      JSON.stringify(afterRemoval.diagnostics)
    )

    const completion = (await timeout(
      connection.sendRequest('textDocument/completion', {
        textDocument: { uri: URI },
        position: { line: 6, character: 6 }
      }),
      15_000,
      'completion'
    )) as { items?: { label: string }[] } | { label: string }[] | null
    const items = Array.isArray(completion) ? completion : (completion?.items ?? [])
    assert.ok(
      items.some((item) => item.label.toLowerCase().startsWith('send')),
      items.map((item) => item.label).join(' | ')
    )

    const hover = (await timeout(
      connection.sendRequest('textDocument/hover', {
        textDocument: { uri: URI },
        position: { line: 4, character: 8 }
      }),
      15_000,
      'hover'
    )) as { contents?: { value?: string } } | null
    assert.match(JSON.stringify(hover), /Send/)

    await delay(50)
    await timeout(connection.sendRequest('shutdown'), 5_000, 'shutdown').catch(() => undefined)
    connection.sendNotification('exit')
    await waitForExit(child, 5_000)
  } catch (error) {
    child.kill()
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n--- server stderr ---\n${stderr}`
    )
  } finally {
    connection.dispose()
  }
})
