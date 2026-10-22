import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareServerCommand, SkriptServer } from '../src/index'

interface FakeServer {
  server: SkriptServer
  writes: string[]
  emit: (chunk: string) => void
}

/**
 * Gerçek Paper süreci başlatmadan komut penceresini sınar: `start()` hazır bir promise döner,
 * `process.stdin` yazılanları toplar, `onOutput` sunucu çıktısını taklit eder.
 */
function makeFakeServer(): FakeServer {
  const server = new SkriptServer({ rootDir: join(tmpdir(), 'skript-ide-command-test') })
  const writes: string[] = []
  const internals = server as unknown as {
    process: { stdin: { write: (text: string) => boolean } }
    startPromise: Promise<void> | null
    onOutput: (chunk: string) => void
  }
  internals.process = {
    stdin: {
      write: (text) => {
        writes.push(text)
        return true
      }
    }
  }
  internals.startPromise = Promise.resolve()
  return { server, writes, emit: (chunk) => internals.onOutput(chunk) }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

function ackToken(writes: string[]): string {
  const last = writes.at(-1) ?? ''
  const match = /^skriptide-ack (\S+)\n$/.exec(last)
  assert.ok(match, `ACK komutu gönderilmedi: ${last}`)
  return match[1]
}

test('runCommands komutları / olmadan sırayla gönderir, ACK ile biter ve satırları toplar', async () => {
  const { server, writes, emit } = makeFakeServer()
  const run = server.runCommands(['/say hi', '  give @a stone  '], { settleMs: 20, timeoutMs: 2000 })
  await tick()

  assert.deepEqual(writes.slice(0, 2), ['say hi\n', 'give @a stone\n'])
  const token = ackToken(writes)
  emit('[12:00:00 INFO]: [Server] hi\n')
  emit(`[12:00:00 INFO]: SKRIPT_IDE_ACK:${token}\n`)

  const result = await run
  assert.deepEqual(result.output, ['[Server] hi'])
  assert.equal(result.acknowledged, true)
  assert.equal(result.timedOut, false)
  assert.equal(result.matchedUntil, false)
  assert.ok(result.durationMs >= 0)
})

test('until eşleşince sessizliği beklemeden biter', async () => {
  const { server, emit } = makeFakeServer()
  const startedAt = Date.now()
  const run = server.runCommands(['say hi'], { until: /done/i, settleMs: 5000, timeoutMs: 5000 })
  await tick()
  emit('[12:00:00 INFO]: everything DONE now\n')

  const result = await run
  assert.equal(result.matchedUntil, true)
  assert.deepEqual(result.output, ['everything DONE now'])
  assert.ok(Date.now() - startedAt < 1000)
})

test('ACK gelmezse son satırdan sonra settleMs sessizlikle biter', async () => {
  const { server, emit } = makeFakeServer()
  const run = server.runCommands(['say hi'], { settleMs: 30, timeoutMs: 3000 })
  await tick()
  emit('[12:00:00 INFO]: hi\n')

  const result = await run
  assert.equal(result.acknowledged, false)
  assert.equal(result.timedOut, false)
  assert.deepEqual(result.output, ['hi'])
})

test('çıktı hiç gelmezse timeoutMs sonunda timedOut ile biter', async () => {
  const { server } = makeFakeServer()
  const result = await server.runCommands(['say nothing'], { settleMs: 30, timeoutMs: 100 })
  assert.equal(result.timedOut, true)
  assert.equal(result.acknowledged, false)
  assert.deepEqual(result.output, [])
})

test('iptal edilen pencere beklemeden kapanır', async () => {
  const { server } = makeFakeServer()
  const controller = new AbortController()
  const run = server.runCommands(['say hi'], { signal: controller.signal, settleMs: 5000, timeoutMs: 5000 })
  await tick()
  controller.abort()
  const result = await run
  assert.equal(result.timedOut, false)
  assert.deepEqual(result.output, [])
})

test('komut pencereleri aynı kuyruğa girer; ikincisi birincisi bitmeden gönderilmez', async () => {
  const { server, writes, emit } = makeFakeServer()
  const first = server.runCommands(['say one'], { settleMs: 10, timeoutMs: 2000 })
  const second = server.runCommands(['say two'], { settleMs: 10, timeoutMs: 2000 })
  await tick()
  assert.deepEqual(writes.slice(0, 2), ['say one\n', `skriptide-ack ${ackToken(writes)}\n`])

  emit(`[12:00:00 INFO]: SKRIPT_IDE_ACK:${ackToken(writes)}\n`)
  await first
  await tick()
  assert.deepEqual(writes.slice(2, 3), ['say two\n'])
  emit(`[12:00:00 INFO]: SKRIPT_IDE_ACK:${ackToken(writes)}\n`)
  await second
})

test('yasaklı, çok satırlı ve boş komutlar sunucuya gitmeden reddedilir', async () => {
  const { server, writes } = makeFakeServer()
  for (const command of ['stop', '/reload', 'op Steve', 'deop Steve', 'whitelist on', 'ban Steve', 'pardon Steve', 'say a\nstop']) {
    await assert.rejects(server.runCommands([command]), Error, command)
  }
  await assert.rejects(server.runCommands([]), Error)
  assert.equal(writes.length, 0)
  assert.equal(prepareServerCommand('/say hi'), 'say hi')
  assert.equal(prepareServerCommand('  sk reload ide/main.sk '), 'sk reload ide/main.sk')
  assert.throws(() => prepareServerCommand('stop'), Error)
})

test('readLog son satırları döndürür, ANSI ve boş satırları ayıklar', () => {
  const { server, emit } = makeFakeServer()
  emit('\u001b[32m[12:00:00 INFO]: bir\u001b[0m\n\n')
  emit('[12:00:00 INFO]: iki\n')
  emit('[12:00:00 INFO]: SKRIPT_IDE_ACK:token\n> skriptide-ack token\n')
  assert.deepEqual(server.readLog(2), ['[12:00:00 INFO]: bir', '[12:00:00 INFO]: iki'])
  assert.deepEqual(server.readLog(1), ['[12:00:00 INFO]: iki'])
})
