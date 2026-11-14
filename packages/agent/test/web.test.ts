import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWebTools, htmlToReadable, parseDuckDuckGoHtml, searchBackends, unwrapDuckDuckGoUrl } from '../src/tools/web'
import { assertPublicUrl, isBlockedAddress, request, type NetDeps } from '../src/tools/web-net'
import { makeContext } from './helpers'

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function fakeDeps(handler: Handler, hosts: Record<string, string[]> = {}): NetDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url, init) => (calls.push(`${init.method ?? 'GET'} ${url}`), handler(url, init)),
    lookup: async (host) => hosts[host] ?? ['93.184.215.14']
  }
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })

function tool(name: string, deps: NetDeps, env: Record<string, string> = {}) {
  const found = createWebTools({ deps, env: (key) => env[key] }).find((item) => item.name === name)
  assert.ok(found)
  return found
}

test('blocks private, loopback, link-local and mapped addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isBlockedAddress(address), true, address)
  }
  for (const address of ['93.184.215.14', '8.8.8.8', '2606:4700::1111']) assert.equal(isBlockedAddress(address), false, address)
})

test('rejects non-http schemes, localhost and hosts resolving to private addresses', async () => {
  const lookup = async (host: string) => (host === 'intranet.example.com' ? ['10.0.0.5'] : ['93.184.215.14'])
  await assert.rejects(assertPublicUrl('file:///etc/passwd', lookup), /Only http and https/)
  await assert.rejects(assertPublicUrl('http://localhost:3000/', lookup), /local address/)
  await assert.rejects(assertPublicUrl('http://127.0.0.1/', lookup), /private network/)
  await assert.rejects(assertPublicUrl('http://[::1]/', lookup), /private network/)
  await assert.rejects(assertPublicUrl('https://intranet.example.com/', lookup), /private network/)
  assert.equal((await assertPublicUrl('https://example.com/a', lookup)).href, 'https://example.com/a')
})

test('re-validates redirect targets and refuses a redirect to a private address', async () => {
  const deps = fakeDeps(
    (url) => (url.startsWith('https://example.com') ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }) : html('secret')),
    {}
  )
  await assert.rejects(request('https://example.com/go', { signal: new AbortController().signal }, deps), /private network/)
  assert.deepEqual(deps.calls, ['GET https://example.com/go'])
})

test('follows public redirects and cuts the body at the byte limit', async () => {
  const deps = fakeDeps((url) => (url.endsWith('/old') ? new Response(null, { status: 301, headers: { location: '/new' } }) : html('x'.repeat(5000))))
  const response = await request('https://example.com/old', { signal: new AbortController().signal, maxBytes: 1000 }, deps)
  assert.equal(response.url, 'https://example.com/new')
  assert.equal(response.body.length, 1000)
  assert.equal(response.truncated, true)
})

test('htmlToReadable drops scripts and styles and keeps headings, links, lists and code', () => {
  const page = htmlToReadable(
    `<html><head><title>Docs &amp; more</title><style>.a{color:red}</style><script>alert("hi")</script></head>
     <body><nav><a href="/x">Menu</a></nav><main><h1>Send effect</h1><p>Sends a <b>message</b>. See <a href="/docs/expr">expressions</a>.</p>
     <ul><li>one</li><li>two</li></ul><pre><code>on join:
    send "hi" to player</code></pre><p>${'filler text '.repeat(30)}</p></main><script>evil()</script></body></html>`,
    'https://docs.example.com/page'
  )
  assert.equal(page.title, 'Docs & more')
  assert.match(page.text, /^# Send effect/)
  assert.match(page.text, /\[expressions\]\(https:\/\/docs\.example\.com\/docs\/expr\)/)
  assert.match(page.text, /- one\n- two/)
  assert.match(page.text, /```\non join:\n    send "hi" to player\n```/)
  assert.doesNotMatch(page.text, /alert|evil|color:red|Menu/)
})

test('parses DuckDuckGo results and unwraps redirect links', () => {
  const body = `
    <div class="result results_links results_links_deep web-result ">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmodrinth.com%2Fplugin%2Fskbee&amp;rut=abc">SkBee - <b>Plugin</b></a>
      <a class="result__snippet" href="x"><b>SkBee</b> is a Skript addon &amp; more.</a>
    </div>
    <div class="result result--ad results_links">
      <a class="result__a" href="https://ads.example.com/">Ad</a>
    </div>
    <div class="result results_links">
      <a class="result__a" href="https://github.com/ShaneBee/SkBee">GitHub</a>
    </div>`
  assert.deepEqual(parseDuckDuckGoHtml(body), [
    { title: 'SkBee - Plugin', url: 'https://modrinth.com/plugin/skbee', snippet: 'SkBee is a Skript addon & more.' },
    { title: 'GitHub', url: 'https://github.com/ShaneBee/SkBee', snippet: '' }
  ])
  assert.equal(unwrapDuckDuckGoUrl('https://example.com/a'), 'https://example.com/a')
})

test('web_search uses DuckDuckGo without keys, adds site filters and reports a block page', async () => {
  let sent = ''
  const deps = fakeDeps((_url, init) => {
    sent = String(init.body)
    return html('<div class="result"><a class="result__a" href="https://skunity.com/t/1">Thread</a><div class="result__snippet">Answer</div></div>')
  })
  const output = await tool('web_search', deps).execute({ query: 'skript gui', domains: ['https://skunity.com/forums'] }, makeContext())
  assert.equal(new URLSearchParams(sent).get('q'), 'skript gui site:skunity.com')
  assert.match(output, /DuckDuckGo results.*\n\n1\. Thread\n {3}https:\/\/skunity\.com\/t\/1\n {3}Answer/)

  const blocked = fakeDeps(() => html('<form id="challenge-form">anomaly detected</form>'))
  await assert.rejects(tool('web_search', blocked).execute({ query: 'x' }, makeContext()), /blocked the automated search/)
})

test('web_search prefers a keyed backend and falls back to DuckDuckGo when it fails', async () => {
  assert.deepEqual(searchBackends((key) => ({ TAVILY_API_KEY: 't', BRAVE_SEARCH_API_KEY: 'b' })[key]).map((b) => b.name), ['Tavily', 'Brave Search', 'DuckDuckGo'])
  const deps = fakeDeps((url) =>
    url.includes('tavily') ? new Response('{}', { status: 500 }) : html('<div class="result"><a class="result__a" href="https://a.example.com/">A</a></div>')
  )
  const output = await tool('web_search', deps, { TAVILY_API_KEY: 'key' }).execute({ query: 'x' }, makeContext())
  assert.match(output, /^DuckDuckGo results for "x" \(fallback; Tavily failed: api\.tavily\.com answered HTTP 500\.\)/)
})

test('web_fetch pages long text, caches the page and hints at the browser for empty pages', async () => {
  const text = 'word '.repeat(1000)
  const deps = fakeDeps((url) => (url.endsWith('/empty') ? html('<html><body><div id="app"></div></body></html>') : html(`<title>Long</title><p>${text}</p>`)))
  const fetchTool = tool('web_fetch', deps)
  const first = await fetchTool.execute({ url: 'https://example.com/long', max_chars: 1000 }, makeContext())
  assert.match(first, /Title: Long\nCharacters 0-1000 of 4999/)
  assert.match(first, /untrusted data/)
  assert.match(first, /offset=1000/)
  const second = await fetchTool.execute({ url: 'https://example.com/long', offset: 4500, max_chars: 1000 }, makeContext())
  assert.match(second, /Characters 4500-4999 of 4999/)
  assert.doesNotMatch(second, /offset=/)
  assert.equal(deps.calls.length, 1)
  assert.match(await fetchTool.execute({ url: 'https://example.com/empty' }, makeContext()), /browser_open/)
})

test('web_fetch formats JSON and rejects binary content', async () => {
  const deps = fakeDeps((url) =>
    url.endsWith('.json')
      ? new Response('{"a":1}', { headers: { 'content-type': 'application/json' } })
      : new Response('PK', { headers: { 'content-type': 'application/zip' } })
  )
  assert.match(await tool('web_fetch', deps).execute({ url: 'https://example.com/a.json' }, makeContext()), /\{\n {2}"a": 1\n\}/)
  await assert.rejects(tool('web_fetch', deps).execute({ url: 'https://example.com/a.zip' }, makeContext()), /application\/zip/)
})
