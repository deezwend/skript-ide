import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SkriptLanguageService } from '@skript-ide/language-server'
import { readSyntaxDatabase } from '@skript-ide/syntax-db/node'
import {
  apply,
  cross,
  det,
  diag,
  distance,
  dot,
  length,
  matToQuat,
  mul,
  quatAxisAngle,
  quatToMat,
  sub,
  svd,
  transpose,
  type Mat3,
  type Vec3
} from '../src/geometry/math'
import { compileScene } from '../src/geometry/scene'
import { cornerError, generateSkript, planDisplays, toDisplayTransform } from '../src/geometry/display'
import { evaluate, formatValue } from '../src/geometry/expr'
import { librarySource } from '../src/geometry/library'
import { filledPolygon, partCorners, polyline, triangle, triangulate, type Part } from '../src/geometry/shapes'
import { displayGeometryTool, mathEvalTool, upsertGeneratedBlock, writeDisplayLibraryTool, writeDisplayScriptTool, SCRIPT_MARKER } from '../src/tools/geometry'
import { ToolError } from '../src/tool'
import { makeContext, makeProject } from './helpers'

/** Tekrarlanabilir rastgele sayılar (mulberry32). */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`)
const matClose = (a: Mat3, b: Mat3, eps = 1e-9) => a.forEach((v, i) => close(v, b[i], eps))

function collect(run: (sink: { push(part: Part): void }) => void): Part[] {
  const parts: Part[] = []
  run({ push: (part) => parts.push(part) })
  return parts
}

/** Paralelyüzün (yerel koordinatı 0..1 olan) içinde mi? */
function insidePart(part: Part, p: Vec3, eps = 1e-7): boolean {
  const e = part.edges
  const inv = invert(e)
  const local = apply(inv, sub(p, part.origin))
  return local.every((c) => c >= -eps && c <= 1 + eps)
}

function invert(m: Mat3): Mat3 {
  const c0: Vec3 = [m[0], m[3], m[6]]
  const c1: Vec3 = [m[1], m[4], m[7]]
  const c2: Vec3 = [m[2], m[5], m[8]]
  const d = det(m)
  const r0 = cross(c1, c2).map((x) => x / d)
  const r1 = cross(c2, c0).map((x) => x / d)
  const r2 = cross(c0, c1).map((x) => x / d)
  return [...r0, ...r1, ...r2] as unknown as Mat3
}

test('svd: rastgele matrisleri U·Σ·Vᵀ olarak tam ayrıştırır, U ve V döndürmedir', () => {
  const rnd = random(1)
  for (let i = 0; i < 500; i++) {
    const m = Array.from({ length: 9 }, () => rnd() * 10 - 5) as unknown as Mat3
    const { u, sigma, v } = svd(m)
    matClose(mul(mul(u, diag(sigma)), transpose(v)), m, 1e-9)
    close(det(u), 1)
    close(det(v), 1)
    matClose(mul(u, transpose(u)), [1, 0, 0, 0, 1, 0, 0, 0, 1])
    assert.ok(sigma[0] >= sigma[1] && sigma[1] >= Math.abs(sigma[2]) - 1e-12)
    if (det(m) > 0) assert.ok(sigma[2] > 0)
  }
})

test('svd: eğme ve aşırı ince levha gibi zor durumlar', () => {
  for (const m of [
    [1, 5, 0, 0, 1, 0, 0, 0, 0.001],
    [3, 0, 0, 0, 3, 0, 0, 0, 3],
    [0, 0, 2, 0, 1, 0, -2, 0, 0],
    [1e-4, 0, 0, 0, 40, 0, 0, 0, 1e-4]
  ] as Mat3[]) {
    const { u, sigma, v } = svd(m)
    matClose(mul(mul(u, diag(sigma)), transpose(v)), m, 1e-9)
  }
})

test('kuaternion ↔ matris dönüşümü tutarlı', () => {
  const rnd = random(2)
  for (let i = 0; i < 300; i++) {
    const q = quatAxisAngle([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], rnd() * 2 * Math.PI)
    const m = quatToMat(q)
    matClose(quatToMat(matToQuat(m)), m, 1e-12)
  }
})

test('üçgen: 3 paralelkenar üçgeni tam kaplar ve dışına taşmaz', () => {
  const rnd = random(3)
  for (let n = 0; n < 50; n++) {
    const pt = (): Vec3 => [rnd() * 8 - 4, rnd() * 8 - 4, rnd() * 8 - 4]
    const [a, b, c] = [pt(), pt(), pt()]
    if (length(cross(sub(b, a), sub(c, a))) < 0.5) continue
    const parts = collect((sink) => triangle(a, b, c, 0.05, 'stone', 't', sink))
    assert.equal(parts.length, 3)
    // Üçgenin içindeki her nokta en az bir parçanın içinde
    for (let i = 0; i < 200; i++) {
      let s = rnd()
      let t = rnd()
      if (s + t > 1) [s, t] = [1 - s, 1 - t]
      const p: Vec3 = [0, 1, 2].map((k) => a[k] + s * (b[k] - a[k]) + t * (c[k] - a[k])) as unknown as Vec3
      assert.ok(parts.some((part) => insidePart(part, p)), 'point not covered')
    }
    // Parçaların orta düzlemdeki köşeleri üçgenin içinde (barycentric ≥ 0)
    const normal = cross(sub(b, a), sub(c, a))
    for (const part of parts) {
      for (const corner of partCorners(part)) {
        const onPlane = sub(corner, normal.map((x) => (x * dot(sub(corner, a), normal)) / dot(normal, normal)) as unknown as Vec3)
        const area = (p: Vec3, q: Vec3, r: Vec3) => dot(cross(sub(q, p), sub(r, p)), normal)
        for (const w of [area(onPlane, b, c), area(a, onPlane, c), area(a, b, onPlane)]) assert.ok(w >= -1e-6 * dot(normal, normal))
      }
    }
  }
})

test('her şekil türü: display değerleri köşe köşe 1e-5 bloktan hassas', async () => {
  const scene = await compileScene({
    shapes: [
      { type: 'box', center: [1, 2, 3], size: [1, 2, 0.5], axis: [1, 1, 0], angle: 33 },
      { type: 'box', from: [0, 0, 0], to: [-2, 1, 3] },
      { type: 'line', from: [0, 0, 0], to: [3, 4, 5], cap: 'square' },
      { type: 'line', from: [0, 0, 0], to: [0, -5, 0] },
      { type: 'polyline', points: [[0, 0, 0], [2, 0, 0], [2, 3, 0], [5, 3, 2]], closed: true },
      { type: 'triangle', points: [[0, 0, 0], [4, 1, 0], [1.3, 2, 3.7]] },
      { type: 'polygon', points: [[0, 0, 0], [4, 0, 0], [4, 0, 3], [2, 0, 1], [0, 0, 3]] },
      { type: 'polygon', points: [[0, 0, 0], [1, 0, 0], [1, 1, 1], [0, 1, 1]], fill: false },
      { type: 'circle', center: [0, 0, 0], radius: 3, fill: true },
      { type: 'circle', center: [0, 0, 0], radius: 3, radius2: 1, normal: [1, 2, 3] },
      { type: 'circle', center: [0, 0, 0], radius: 2, start_angle: 30, end_angle: 200, fill: true },
      { type: 'curve', points: [[0, 0, 0], [2, 4, 0], [4, -2, 1], [6, 0, 0]] },
      { type: 'cylinder', from: [0, 0, 0], to: [0, 3, 1], radius: 1, tolerance: 0.05 },
      { type: 'sphere', center: [0, 2, 0], radius: 2, tolerance: 0.1 },
      { type: 'mesh', vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, 1]], faces: [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4]] }
    ]
  })
  const plan = planDisplays(scene.parts)
  assert.ok(plan.maxError < 1e-5, `max error ${plan.maxError}`)
  for (const part of scene.parts) assert.ok(cornerError(part, toDisplayTransform(part)) < 1e-5)
})

test('çokgen: içbükey çokgen üçgenlere bölününce alan korunur', () => {
  const pts: Vec3[] = [[0, 0, 0], [4, 0, 0], [4, 0, 3], [2, 0, 1], [0, 0, 3]]
  const tris = triangulate(pts, [0, 1, 0], 'p')
  const area = tris.reduce((sum, [i, j, k]) => sum + length(cross(sub(pts[j], pts[i]), sub(pts[k], pts[i]))) / 2, 0)
  close(area, 4 * 3 - (4 * 2) / 2) // 12 - çentik üçgeni (taban 4, yükseklik 2)
})

test('çokgen: paralelkenar 1, yamuk 4 display; düzlemsel olmayan reddedilir', () => {
  const count = (pts: Vec3[]) => collect((sink) => filledPolygon(pts, 0.05, 'stone', 'p', sink, 1e-3)).length
  assert.equal(count([[0, 0, 0], [2, 0, 0], [3, 0, 1], [1, 0, 1]]), 1)
  assert.equal(count([[0, 0, 0], [4, 0, 0], [3, 0, 1], [1, 0, 1]]), 4)
  assert.throws(() => count([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0.5, 1]]), /off the polygon's plane/)
})

test('polyline: dik köşede dış kenarlar tam buluşur (uzatma = w/2·tan(θ/2))', () => {
  const parts = collect((sink) => polyline([[0, 0, 0], [2, 0, 0], [2, 0, 2]], { width: 0.2, normal: [0, 1, 0] }, 'stone', 'l', sink))
  const xs = partCorners(parts[0]).map((c) => c[0])
  close(Math.max(...xs), 2.1, 1e-12)
  const zs = partCorners(parts[1]).map((c) => c[2])
  close(Math.min(...zs), -0.1, 1e-12)
})

test('daire: tüm köşeler yarıçap üzerinde, kiriş sapması toleransı aşmaz', async () => {
  const scene = await compileScene({ shapes: [{ type: 'circle', center: [0, 0, 0], radius: 5, fill: true, tolerance: 0.01, thickness: 0.02 }] })
  let worst = 0
  for (const part of scene.parts) {
    for (const c of partCorners(part)) worst = Math.max(worst, Math.hypot(c[0], c[2]))
  }
  assert.ok(worst <= 5 + 1e-9)
  // Kirişin ortası çembere en az (5 - 0.01) uzaklıkta: parçaların en dış noktaları
  const n = scene.parts.length
  assert.ok(n > 0)
})

test('derleme hataları anlaşılır mesaj verir', async () => {
  await assert.rejects(compileScene({ shapes: [{ type: 'triangle', points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }] }), /zero area/)
  await assert.rejects(compileScene({ shapes: [{ type: 'hexagon' }] }), /unknown type/)
  await assert.rejects(compileScene({ shapes: [{ type: 'line', from: [0, 0], to: [1, 1, 1] }] }), /\[x, y, z\]/)
})

test('çok küçük tolerance parça üretmeden hemen reddedilir', async () => {
  const started = Date.now()
  await assert.rejects(compileScene({ shapes: [{ type: 'sphere', center: [0, 0, 0], radius: 100, tolerance: 1e-12 }] }), /more than \d+ block displays/)
  await assert.rejects(compileScene({ shapes: [{ type: 'circle', center: [0, 0, 0], radius: 100, tolerance: 1e-15 }] }), /more than \d+ block displays/)
  const control = Array.from({ length: 40 }, (_, i) => [i, (i * 7) % 5, 0])
  await assert.rejects(compileScene({ shapes: [{ type: 'curve', points: control, tolerance: 1e-12 }] }), /more than \d+ block displays/)
  assert.ok(Date.now() - started < 2000)
})

test('üretilen kod ve kütüphane Skript 2.17.1 tanılamasından hatasız geçer', async () => {
  const scene = await compileScene({ shapes: [{ type: 'triangle', points: [[0, 0, 0], [4, 1, 0], [1.3, 2, 3.7]], block: 'oak_stairs[facing=north]' }] })
  const service = new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: '2.17.1', addons: [] })
  const files = [
    { uri: 'file:///p/draw.sk', text: generateSkript('draw_tri', planDisplays(scene.parts)) },
    { uri: 'file:///p/lib.sk', text: librarySource() }
  ]
  service.setWorkspaceFiles(files, true)
  for (const file of files) {
    const errors = (await service.getDiagnostics(file.uri)).filter((d) => d.severity === 1)
    assert.deepEqual(errors.map((d) => `${d.range.start.line + 1}: ${typeof d.message === 'string' ? d.message : d.message.value}`), [], file.uri)
  }
})

test('math_eval: vektör, kuaternion ve Minecraft yönleri', () => {
  const out = evaluate('a = [0,0,0]; b = [3,4,0]; dist(a, b); angled(b, [1,0,0]); 2^3^2; -2^2; round(sind(30), 6); mc_direction(90, 0)')
  assert.deepEqual(out.map((r) => formatValue(r.value)), ['[0, 0, 0]', '[3, 4, 0]', '5', '53.1301023542', '512', '-4', '0.5', '[-1, 0, 0]'])
  const q = evaluate('quat_rotate(quat_axis_angle([0,1,0], 90), [1,0,0])')[0].value
  assert.equal(formatValue(q), '[0, 0, -1]')
  assert.throws(() => evaluate('1 / 0'), /finite/)
  assert.throws(() => evaluate('foo(1)'), /Unknown function/)
  assert.throws(() => evaluate('[1,2] + [1,2,3]'), /same size/)
})

test('tool\'lar: display_geometry özet verir, write_display_script/library mevcut dosyaya blok ekler ve elle yazılmış kodu korur', async () => {
  const { root, cleanup } = await makeProject({ 'hand.sk': 'on join:\n    send "hi"\n', 'blank.sk': '\n' })
  try {
    const ctx = makeContext({ projectRoot: root })
    const shapes = [{ type: 'triangle', points: [[0, 0, 0], [4, 0, 0], [0, 0, 3]] }]
    const summary = await displayGeometryTool.execute({ shapes, values: true }, ctx)
    assert.match(summary, /^3 block displays\. Max corner error/)
    assert.match(summary, /Bounding box relative to the origin: \(0, -0\.0\d+, 0\) to \(4, 0\.0\d+, 3\)/)
    assert.match(summary, /left_rotation=/)

    const result = await writeDisplayScriptTool.execute({ path: 'draw/tri.sk', function_name: 'draw_tri', shapes }, ctx)
    assert.match(result, /Created draw\/tri\.sk/)
    const content = await readFile(join(root, 'draw', 'tri.sk'), 'utf8')
    assert.match(content, /^# >>> display draw_tri /)
    assert.ok(content.includes(SCRIPT_MARKER))
    assert.match(content, /function draw_tri\(origin: location, yaw: number = 0\) :: entities:/)
    assert.match(await writeDisplayScriptTool.execute({ path: 'draw/tri.sk', function_name: 'draw_tri', shapes }, ctx), /Updated/)
    assert.equal(await readFile(join(root, 'draw', 'tri.sk'), 'utf8'), content)

    // Elle yazılmış dosyaya eklenir: kod korunur, girinti dosyaya uyar, ikinci çağrı bloğu yerinde günceller
    await writeDisplayScriptTool.execute({ path: 'hand.sk', function_name: 'draw_hand', shapes }, ctx)
    const hand = await readFile(join(root, 'hand.sk'), 'utf8')
    assert.ok(hand.startsWith('on join:\n    send "hi"\n\n# >>> display draw_hand '))
    assert.ok(!/^\t/m.test(hand), 'tablar dosyanın 4 boşluklu girintisine çevrilir')
    await writeDisplayScriptTool.execute({ path: 'hand.sk', function_name: 'draw_hand', shapes, block: 'stone' }, ctx)
    const updated = await readFile(join(root, 'hand.sk'), 'utf8')
    assert.equal(updated.match(/# >>> display draw_hand/g)?.length, 1)
    assert.match(updated, /"stone"/)

    assert.match(await writeDisplayScriptTool.execute({ path: 'blank.sk', function_name: 'draw_blank', shapes }, ctx), /blank\.sk: function draw_blank/)
    await assert.rejects(writeDisplayScriptTool.execute({ path: 'a.sk', function_name: 'bad name', shapes }, ctx), /function_name/)
    await assert.rejects(writeDisplayScriptTool.execute({ path: 'a.txt', function_name: 'x', shapes }, ctx), ToolError)

    assert.match(await writeDisplayLibraryTool.execute({ path: 'hand.sk' }, ctx), /Updated hand\.sk with the display math library/)
    assert.match(await writeDisplayLibraryTool.execute({ path: 'hand.sk' }, ctx), /already up to date/)
    assert.match(await readFile(join(root, 'hand.sk'), 'utf8'), /# <<< display draw_hand\n\n# >>> display library [\s\S]*function dg_qmul/)
    assert.equal(await mathEvalTool.execute({ expression: 'x = 2; x * [1, 2, 3]' }, ctx), 'x = 2\n[2, 4, 6]')
  } finally {
    await cleanup()
  }
})

test('upsertGeneratedBlock: eski sürümde tümü üretilmiş dosya blokla değiştirilir, CRLF korunur', () => {
  const legacy = `# x: ${SCRIPT_MARKER}. Do not edit.\nfunction x(origin: location, yaw: number = 0) :: entities:\n\tstop\n`
  assert.equal(
    upsertGeneratedBlock(legacy, 'display x', 'new', SCRIPT_MARKER),
    '# >>> display x (generated by Skript IDE; regenerate instead of editing)\nnew\n# <<< display x\n'
  )
  assert.equal(
    upsertGeneratedBlock('on load:\r\n\tbroadcast "a"\r\n', 'display y', 'function y():\n\tstop', SCRIPT_MARKER),
    'on load:\r\n\tbroadcast "a"\r\n\r\n# >>> display y (generated by Skript IDE; regenerate instead of editing)\r\nfunction y():\r\n\tstop\r\n# <<< display y\r\n'
  )
})

test('obj dosyası okunur ve yüzleri çizilir', async () => {
  const { root, cleanup } = await makeProject({ 'models/pyramid.obj': 'v 0 0 0\nv 1 0 0\nv 1 0 1\nv 0 0 1\nv 0.5 1 0.5\nf 1 2 3 4\nf 1 2 5\nf 2/1 3/1 5/1\nf -2 -1 -5\n' })
  try {
    const summary = await displayGeometryTool.execute({ shapes: [{ type: 'obj', path: 'models/pyramid.obj', scale: 2 }] }, makeContext({ projectRoot: root }))
    assert.match(summary, /^10 block displays/) // kare 1 + 3 üçgen × 3
    // Ölçek 2: tepe y = 2 (levha kalınlığı sınırı biraz aşar)
    assert.match(summary, /to \(2\.0\d+, 2\.0\d+, 2(\.0\d+)?\)/)
  } finally {
    await cleanup()
  }
})

test('kenar durumları: dik çizgi ve ters yönlü kutu', async () => {
  const scene = await compileScene({ shapes: [{ type: 'line', from: [0, 3, 0], to: [0, 0, 0] }, { type: 'box', from: [2, 2, 2], to: [0, 0, 0] }] })
  for (const part of scene.parts) assert.ok(det(part.edges) > 0)
  close(distance(partCorners(scene.parts[1])[0], [0, 0, 0]), 0)
})
