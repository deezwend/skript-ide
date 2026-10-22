import test from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  latestProjectMemory,
  loadProjectMemory,
  MAX_PROJECT_MEMORY_CHARS,
  parseProjectInstructions,
  projectMemoryUpdate,
  projectMemoryText,
  textMessage,
  type Message
} from '../src/index'
import { makeProject } from './helpers'

test('SKRIPT.md önceliklidir; yoksa AGENTS.md, yoksa .skript-ide/instructions.md okunur', async () => {
  const project = await makeProject({ 'AGENTS.md': 'agents', '.skript-ide/instructions.md': 'nested' })
  try {
    assert.deepEqual(await loadProjectMemory(project.root), { path: 'AGENTS.md', text: 'agents' })
    await writeFile(join(project.root, 'SKRIPT.md'), 'skript rules', 'utf8')
    assert.deepEqual(await loadProjectMemory(project.root), { path: 'SKRIPT.md', text: 'skript rules' })
    await rm(join(project.root, 'SKRIPT.md'))
    await rm(join(project.root, 'AGENTS.md'))
    assert.deepEqual(await loadProjectMemory(project.root), { path: '.skript-ide/instructions.md', text: 'nested' })
  } finally {
    await project.cleanup()
  }
})

test('proje yoksa ya da dosya yoksa null döner', async () => {
  assert.equal(await loadProjectMemory(null), null)
  const project = await makeProject({})
  try {
    assert.equal(await loadProjectMemory(project.root), null)
  } finally {
    await project.cleanup()
  }
})

test('büyük dosya kesilir ve nedeni metne eklenir', async () => {
  const project = await makeProject({ 'SKRIPT.md': 'x'.repeat(MAX_PROJECT_MEMORY_CHARS + 100) })
  try {
    const memory = await loadProjectMemory(project.root)
    assert.ok(memory)
    assert.ok(memory.text.length > MAX_PROJECT_MEMORY_CHARS)
    assert.ok(memory.text.startsWith('x'.repeat(MAX_PROJECT_MEMORY_CHARS)))
    assert.match(memory.text, /truncated/)
  } finally {
    await project.cleanup()
  }
})

test('blok metni ve ayrıştırma gidiş-dönüşü', () => {
  const text = projectMemoryText({ path: 'SKRIPT.md', text: 'Use tabs.\nNo trailing spaces.' })
  assert.equal(text, '<project_instructions path="SKRIPT.md">\nUse tabs.\nNo trailing spaces.\n</project_instructions>')
  assert.deepEqual(parseProjectInstructions(text), { path: 'SKRIPT.md', text: 'Use tabs.\nNo trailing spaces.' })
  assert.equal(parseProjectInstructions('<project_instructions_cleared />'), null)
  assert.equal(parseProjectInstructions('hello'), undefined)
})

test('hafıza değiştiğinde blok eklenir, aynıysa eklenmez, kaldırılınca cleared yazılır', () => {
  const memory = { path: 'SKRIPT.md', text: 'Use tabs.' }
  const messages: Message[] = [textMessage('user', 'hi')]
  assert.equal(projectMemoryUpdate(messages, memory), projectMemoryText(memory))
  messages.push({ role: 'user', content: [{ type: 'text', text: projectMemoryText(memory) }] })
  assert.equal(projectMemoryUpdate(messages, memory), null)
  assert.deepEqual(latestProjectMemory(messages), memory)
  assert.equal(projectMemoryUpdate(messages, { path: 'SKRIPT.md', text: 'Use spaces.' }), projectMemoryText({ path: 'SKRIPT.md', text: 'Use spaces.' }))
  assert.equal(projectMemoryUpdate(messages, null), '<project_instructions_cleared />')
  assert.equal(projectMemoryUpdate([textMessage('user', 'hi')], null), null)
})

test('latestProjectMemory yalnızca user mesajlarındaki son bloğu bulur', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: projectMemoryText({ path: 'SKRIPT.md', text: 'old' }) }] },
    { role: 'assistant', content: [{ type: 'text', text: projectMemoryText({ path: 'SKRIPT.md', text: 'assistant cannot set' }) }] },
    { role: 'user', content: [{ type: 'text', text: 'question' }] }
  ]
  assert.equal(latestProjectMemory(messages)?.text, 'old')
})
