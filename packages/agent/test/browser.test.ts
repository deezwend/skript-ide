import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BrowserController } from '../src/tool'
import { BROWSER_TOOL_NAMES, browserClickTool, browserOpenTool, browserShowTool, browserTools, browserTypeTool } from '../src/tools/browser'
import { makeContext } from './helpers'

function fakeBrowser(calls: string[]): BrowserController {
  return {
    navigate: async (url) => (calls.push(`open ${url}`), `snapshot of ${url}`),
    snapshot: async () => 'snapshot',
    describe: async (ref) => `button "Send" [${ref}]`,
    click: async (ref) => (calls.push(`click ${ref}`), 'after click'),
    type: async (ref, text, options) => (calls.push(`type ${ref} ${text} ${options.clear} ${options.submit}`), 'after type'),
    press: async (key) => `pressed ${key}`,
    scroll: async (direction) => `scrolled ${direction}`,
    back: async () => 'back',
    listTabs: () => '* [1] Example',
    newTab: async () => 'new tab',
    selectTab: async (id) => `tab ${id}`,
    closeTab: async (id) => `closed ${id}`,
    upload: async (ref, files) => (calls.push(`upload ${ref} ${files.length}`), 'after upload'),
    show: () => calls.push('show'),
    currentUrl: () => 'https://example.com/'
  }
}

test('browser tools list matches the exported tools and require approval only for page actions', () => {
  assert.deepEqual(browserTools.map((tool) => tool.name).sort(), [...BROWSER_TOOL_NAMES].sort())
  const exec = browserTools.filter((tool) => tool.permission === 'exec').map((tool) => tool.name).sort()
  assert.deepEqual(exec, ['browser_click', 'browser_close_tab', 'browser_press', 'browser_type', 'browser_upload'])
})

test('browser_open and browser_click drive the controller', async () => {
  const calls: string[] = []
  const context = { ...makeContext(), browser: fakeBrowser(calls) }
  assert.equal(await browserOpenTool.execute({ url: ' https://example.com ' }, context), 'snapshot of https://example.com')
  assert.equal(await browserClickTool.execute({ ref: 3 }, context), 'after click')
  const preview = await browserClickTool.preview!({ ref: 3 }, context)
  assert.match(preview.summary, /button "Send" \[3\].*example\.com/)
  assert.deepEqual(calls, ['open https://example.com', 'click 3'])
})

test('browser_type defaults to replacing the value and shows the text in the approval', async () => {
  const calls: string[] = []
  const context = { ...makeContext(), browser: fakeBrowser(calls) }
  await browserTypeTool.execute({ ref: 2, text: 'hi', submit: true }, context)
  assert.deepEqual(calls, ['type 2 hi true true'])
  assert.match((await browserTypeTool.preview!({ ref: 2, text: 'hi', submit: true }, context)).summary, /"hi".*press Enter/)
})

test('browser tools validate input and need a browser', async () => {
  const context = { ...makeContext(), browser: fakeBrowser([]) }
  await assert.rejects(browserClickTool.execute({ ref: 0 }, context), /positive integer/)
  await assert.rejects(browserOpenTool.execute({ url: '' }, context), /url is required/)
  await assert.rejects(browserOpenTool.execute({ url: 'https://a.b' }, makeContext()), /not available/)
  assert.match(await browserShowTool.execute({}, context), /panel is open/)
})
