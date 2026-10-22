import test from 'node:test'
import assert from 'node:assert/strict'
import type { CommandResult, SkriptServer, ValidationResult } from '@skript-ide/runtime-validator'
import type { ToolContext } from '../src/index'
import { getServerLogTool } from '../src/tools/skript/server-log'
import { runServerCommandTool } from '../src/tools/skript/run-on-server'
import { testScriptTool } from '../src/tools/skript/test-script'
import { makeContext, makeProject } from './helpers'

interface ServerCalls {
  validated: { source: string; fileName: string; content: string }[]
  commands: string[][]
}

type FakeServer = NonNullable<ToolContext['server']> & { calls: ServerCalls }

function makeServer(
  options: {
    eula?: boolean
    state?: SkriptServer['currentStatus']['state']
    validation?: Partial<ValidationResult>
    commandResult?: Partial<CommandResult>
    log?: string[]
  } = {}
): FakeServer {
  const calls: ServerCalls = { validated: [], commands: [] }
  return {
    calls,
    currentStatus: {
      state: options.state ?? 'ready',
      message: 'Ready',
      versions: { skript: '2.17.1', minecraft: '1.21.10' },
      eulaUrl: '',
      addons: []
    } as unknown as SkriptServer['currentStatus'],
    isEulaAccepted: async () => options.eula ?? true,
    validate: async (source, fileName, content) => {
      calls.validated.push({ source, fileName, content })
      return { source, stagedName: fileName, diagnostics: [], ok: true, durationMs: 1200, ...options.validation }
    },
    runCommands: async (commands) => {
      calls.commands.push([...commands])
      return {
        output: [],
        timedOut: false,
        durationMs: 1500,
        acknowledged: true,
        matchedUntil: false,
        ...options.commandResult
      }
    },
    readLog: () => options.log ?? []
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function withProject(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = await makeProject(files)
  try {
    await run(root)
  } finally {
    await cleanup()
  }
}

test('run_server_command komutları iletir, çıktıyı ve süreyi biçimler', async () => {
  const server = makeServer({ commandResult: { output: ['[Server] hi', 'done'], matchedUntil: true } })
  const ctx = { ...makeContext(), server }
  assert.equal(runServerCommandTool.permission, 'exec')

  const preview = await runServerCommandTool.preview!({ commands: ['/say hi'] }, ctx)
  assert.match(preview.summary, /^Run on the local test server: \/say hi \(Skript 2\.17\.1\)$/)

  const result = await runServerCommandTool.execute({ commands: ['/say hi'], wait_for: 'done' }, ctx)
  assert.deepEqual(server.calls.commands, [['say hi']])
  assert.match(result, /^Ran 1 command on the local test server \(Skript 2\.17\.1, Minecraft 1\.21\.10\) in 1\.5s\.\n/)
  assert.match(result, /\n\nOutput:\n\[Server\] hi\ndone$/)
  assert.doesNotMatch(result, /timed out|did not confirm/)
})

test('run_server_command zaman aşımını ve görülmeyen wait_for metnini bildirir', async () => {
  const server = makeServer({ commandResult: { timedOut: true, acknowledged: false } })
  const result = await runServerCommandTool.execute({ commands: ['say hi'], wait_for: 'nope' }, { ...makeContext(), server })
  assert.match(result, /The wait timed out/)
  assert.match(result, /never contained "nope"/)
  assert.match(result, /\(no console output\)/)
})

test('run_server_command yasak komutu ve EULA yokluğunu sunucuya gitmeden reddeder', async () => {
  const server = makeServer()
  const ctx = { ...makeContext(), server }
  await assert.rejects(runServerCommandTool.execute({ commands: ['stop'] }, ctx), /cannot be run on the test server/)
  await assert.rejects(runServerCommandTool.execute({ commands: [] }, ctx), /at least one console command/)
  assert.equal(server.calls.commands.length, 0)

  const eulaServer = makeServer({ eula: false })
  await assert.rejects(runServerCommandTool.execute({ commands: ['say hi'] }, { ...makeContext(), server: eulaServer }), /EULA/)
  assert.equal(eulaServer.calls.commands.length, 0)
})

test('run_server_command iptal edilirse çalışmaz', async () => {
  const server = makeServer()
  const controller = new AbortController()
  controller.abort()
  const ctx = { ...makeContext({ signal: controller.signal }), server }
  await assert.rejects(runServerCommandTool.execute({ commands: ['say hi'] }, ctx), /Cancelled/)
  assert.equal(server.calls.commands.length, 0)
})

test('test_script betiği yükler, komutları çalıştırır ve PASS/FAIL üretir', () =>
  withProject({ 'main.sk': 'command /greet:\n    trigger:\n        send "Merhaba" to player\n' }, async (root) => {
    const passing = makeServer({ commandResult: { output: ['[Server] Merhaba', 'done'], matchedUntil: true } })
    const result = await testScriptTool.execute(
      { path: 'main.sk', commands: ['greet'], expect: ['merhaba'], forbid: ['error'] },
      { ...makeContext({ projectRoot: root }), server: passing }
    )
    assert.match(result, /^PASS main\.sk on Skript 2\.17\.1 \(Minecraft 1\.21\.10\): loaded and ran 1 command in 1\.5s\./)
    assert.equal(passing.calls.validated[0].fileName, 'main.sk')
    assert.deepEqual(passing.calls.commands[0], ['greet'])
    await tick()
    assert.deepEqual(passing.calls.commands[1], ['sk disable ide/main.sk'])

    const failing = makeServer({ commandResult: { output: ['[Server] Merhaba'] } })
    const failed = await testScriptTool.execute(
      { path: 'main.sk', commands: ['greet'], expect: ['hoş geldin'] },
      { ...makeContext({ projectRoot: root }), server: failing }
    )
    assert.match(failed, /^FAIL main\.sk/)
    assert.match(failed, /Unmet expectations:\n- "hoş geldin" was not found in the output/)
  }))

test('test_script yasak metni ve Skript runtime hatasını ayrıca bildirir', () =>
  withProject({ 'main.sk': 'on load:\n\tsend "hi"\n' }, async (root) => {
    const server = makeServer({
      commandResult: {
        output: ['[Server] error while executing command', 'java.lang.RuntimeException: boom']
      }
    })
    const result = await testScriptTool.execute(
      { path: 'main.sk', commands: ['say hi'], forbid: ['error'] },
      { ...makeContext({ projectRoot: root }), server }
    )
    assert.match(result, /^FAIL /)
    assert.match(result, /Forbidden text found:\n- "error"/)
    assert.match(result, /Skript runtime errors:\n- \[Server\] error while executing command\n- java\.lang\.RuntimeException: boom/)
  }))

test('test_script yükleme hatasında komutları çalıştırmaz', () =>
  withProject({ 'main.sk': 'on join:\n\tsend "x" to playr\n' }, async (root) => {
    const server = makeServer({
      validation: {
        ok: false,
        diagnostics: [
          {
            file: 'ide\\main.sk',
            line: 2,
            severity: 'error',
            message: "Can't understand this expression",
            code: 'send "x" to playr'
          }
        ]
      }
    })
    const result = await testScriptTool.execute(
      { path: 'main.sk', commands: ['greet'] },
      { ...makeContext({ projectRoot: root }), server }
    )
    assert.match(result, /^FAIL main\.sk on Skript 2\.17\.1/)
    assert.match(result, /did not load, so no commands were run/)
    assert.match(result, /main\.sk:2: error: Can't understand this expression\n {4}send "x" to playr/)
    assert.equal(server.calls.commands.length, 0)
  }))

test('test_script .sk olmayan dosyayı reddeder', () =>
  withProject({ 'notes.txt': 'x' }, async (root) => {
    const server = makeServer()
    await assert.rejects(
      testScriptTool.execute({ path: 'notes.txt', commands: ['say hi'] }, { ...makeContext({ projectRoot: root }), server }),
      /not a \.sk file/
    )
  }))

test('get_server_log son satırları filtreler; sunucu yoksa bunu söyler', async () => {
  const ctx = () => makeContext()
  const ready = makeServer({ log: ['[12:00:00 INFO]: bir', '[12:00:00 INFO]: ERROR iki', ''] })
  assert.equal(getServerLogTool.permission, 'read')
  const filtered = await getServerLogTool.execute({ filter: 'error' }, { ...ctx(), server: ready })
  assert.match(filtered, /^Last 1 console line from the local test server \(state: ready\) matching "error":\n/)
  assert.match(filtered, /\[12:00:00 INFO\]: ERROR iki$/)

  const stopped = makeServer({ log: [], state: 'stopped' })
  const empty = await getServerLogTool.execute({}, { ...ctx(), server: stopped })
  assert.match(empty, /not running and has produced no console output/)

  const noMatch = await getServerLogTool.execute({ filter: 'zzz' }, { ...ctx(), server: ready })
  assert.match(noMatch, /No console lines on the local test server match "zzz"/)
})
