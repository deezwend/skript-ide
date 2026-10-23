/**
 * Şekilleri block display parçalarına indirger. Her parça birim küpün (0..1)³ bir afin dönüşümüdür:
 * bir köşe (`origin`) ve üç kenar vektörü (`edges` sütunları) → paralelyüz. Böylece her şey iki temel
 * yapıya iner: dönmüş/eğilmiş kutu (1 display) ve üçgen (3 paralelkenar).
 */

import {
  add,
  anyPerpendicular,
  column,
  cross,
  det,
  distance,
  dot,
  fromColumns,
  length,
  normalize,
  scale,
  sub,
  type Mat3,
  type Vec3
} from './math'

export interface Part {
  /** Küpün (0,0,0) köşesinin, sahne kökenine göre konumu. */
  origin: Vec3
  /** Sütunlar: küpün x, y, z kenarlarının dönüştüğü vektörler. `det > 0` tutulur. */
  edges: Mat3
  block: string
  /** Parçanın geldiği şekil, ör. `shapes[2] (circle)`; hata/rapor için. */
  source: string
}

export class GeometryError extends Error {}

/** Üst üste binen eş düzlemli yüzlerin titremesini (z-fighting) önleyen kalınlık farkı, blok cinsinden. */
export const Z_FIGHT_STEP = 0.0005
const EPS = 1e-9

export interface PartSink {
  push(part: Part): void
}

/** Kenarlar sol el sistemi oluşturuyorsa aynı paralelyüzü sağ el sistemiyle yazar (negatif ölçek gerekmesin). */
export function makePart(origin: Vec3, e1: Vec3, e2: Vec3, e3: Vec3, block: string, source: string): Part {
  let edges = fromColumns(e1, e2, e3)
  const d = det(edges)
  if (!(Math.abs(d) > EPS * Math.max(1, length(e1) * length(e2) * length(e3)))) {
    throw new GeometryError(`${source}: degenerate part (zero volume); check for repeated or collinear points and a positive thickness/width.`)
  }
  if (d < 0) {
    // P + {e1,e2,e3} ile (P+e3) + {e1,e2,-e3} aynı kümedir
    origin = add(origin, e3)
    edges = fromColumns(e1, e2, scale(e3, -1))
  }
  return { origin, edges, block, source }
}

export function partCorners(part: Part): Vec3[] {
  const [e1, e2, e3] = [column(part.edges, 0), column(part.edges, 1), column(part.edges, 2)]
  const corners: Vec3[] = []
  for (let i = 0; i < 8; i++) {
    let p = part.origin
    if (i & 1) p = add(p, e1)
    if (i & 2) p = add(p, e2)
    if (i & 4) p = add(p, e3)
    corners.push(p)
  }
  return corners
}

// --- Kutu ve çizgi ---

/** Merkez, boyut ve isteğe bağlı eksenlerle (birim, dik) kutu. */
export function box(center: Vec3, size: Vec3, axes: readonly [Vec3, Vec3, Vec3], block: string, source: string): Part {
  const [ax, ay, az] = axes
  const e1 = scale(ax, size[0])
  const e2 = scale(ay, size[1])
  const e3 = scale(az, size[2])
  const origin = sub(center, scale(add(add(e1, e2), e3), 0.5))
  return makePart(origin, e1, e2, e3, block, source)
}

/**
 * `a`'dan `b`'ye kare kesitli çubuk. Kesitin bir ekseni `normal`e paraleldir (düzlemsel çizimlerde
 * çubuk düzleme yatık durur); verilmezse genişlik ekseni yatay seçilir.
 * `extendStart`/`extendEnd` uçları eksen boyunca uzatır (köşe birleşimi için).
 */
export function segment(
  a: Vec3,
  b: Vec3,
  width: number,
  block: string,
  source: string,
  options: { normal?: Vec3; extendStart?: number; extendEnd?: number } = {}
): Part {
  const len = distance(a, b)
  if (len < EPS) throw new GeometryError(`${source}: the two end points are the same.`)
  const dir = scale(sub(b, a), 1 / len)
  const side = sideAxis(dir, options.normal)
  const up = cross(side, dir)
  const start = sub(a, scale(dir, options.extendStart ?? 0))
  const total = len + (options.extendStart ?? 0) + (options.extendEnd ?? 0)
  const origin = sub(start, scale(add(side, up), width / 2))
  return makePart(origin, scale(dir, total), scale(side, width), scale(up, width), block, source)
}

/** Çubuk kesitinin "yan" ekseni: düzlem normali verilmişse düzlem içinde, yoksa yatay. */
function sideAxis(dir: Vec3, normal: Vec3 | undefined): Vec3 {
  if (normal) {
    const s = cross(normal, dir)
    if (length(s) > 1e-6) return normalize(s)
  }
  const horizontal = cross([0, 1, 0], dir)
  if (length(horizontal) > 1e-6) return normalize(horizontal)
  return anyPerpendicular(dir)
}

export interface PolylineOptions {
  width: number
  closed?: boolean
  /** Düzlemsel çizgiler için düzlem normali; kesit buna göre hizalanır ve köşeler tam birleşir. */
  normal?: Vec3
  /** Açık uçlar: `flat` uç noktada biter, `square` yarım genişlik kadar uzar. */
  cap?: 'flat' | 'square'
}

/**
 * Köşelerde dış kenarların tam buluşması için her parça `(w/2)·tan(θ/2)` uzatılır (θ: dönüş açısı).
 * Bu, kesit düzleme hizalıysa düzlem içindeki dış köşeyi kesin olarak kapatır.
 */
export function polyline(points: readonly Vec3[], options: PolylineOptions, block: string, source: string, sink: PartSink): void {
  const pts = dedupe(points, options.closed)
  if (pts.length < 2) throw new GeometryError(`${source}: needs at least 2 distinct points.`)
  const n = pts.length
  const segmentCount = options.closed ? n : n - 1
  const half = options.width / 2
  const capExtension = options.cap === 'square' ? half : 0
  const joint = (prev: Vec3, at: Vec3, next: Vec3): number => {
    const d1 = normalize(sub(at, prev))
    const d2 = normalize(sub(next, at))
    const cos = Math.min(1, Math.max(-1, dot(d1, d2)))
    const theta = Math.acos(cos)
    // Neredeyse geri dönüşte tan sonsuza gider; uzatma makul bir sınırda tutulur
    return Math.min(half * Math.tan(theta / 2), options.width * 2)
  }
  for (let i = 0; i < segmentCount; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const hasPrev = options.closed || i > 0
    const hasNext = options.closed || i + 1 < n - 1
    const extendStart = hasPrev ? joint(pts[(i - 1 + n) % n], a, b) : capExtension
    const extendEnd = hasNext ? joint(a, b, pts[(i + 2) % n]) : capExtension
    sink.push(segment(a, b, options.width, block, `${source} segment ${i + 1}`, { normal: options.normal, extendStart, extendEnd }))
  }
}

function dedupe(points: readonly Vec3[], closed?: boolean): Vec3[] {
  const result: Vec3[] = []
  for (const p of points) if (!result.length || distance(result[result.length - 1], p) > EPS) result.push(p)
  if (closed && result.length > 1 && distance(result[0], result[result.length - 1]) <= EPS) result.pop()
  return result
}

// --- Yüzeyler ---

/** Paralelkenar levha: köşe `p`, kenarlar `e1`, `e2`; kalınlık normal yönünde ortalanır. */
export function parallelogram(p: Vec3, e1: Vec3, e2: Vec3, thickness: number, block: string, source: string): Part {
  const n = cross(e1, e2)
  if (length(n) < EPS) throw new GeometryError(`${source}: the points are collinear.`)
  const t = scale(normalize(n), thickness)
  return makePart(sub(p, scale(t, 0.5)), e1, e2, t, block, source)
}

/**
 * Dolu üçgen = köşelerden kenar ortalarına uzanan 3 paralelkenarın birleşimi:
 * A, M_AB, M_BC, M_AC paralelkenarı A köşesindeki küçük üçgeni ve orta üçgeni kapsar; üçü birlikte tamamını.
 * Parçalar üst üste bindiğinden kalınlıkları `Z_FIGHT_STEP` kadar farklıdır (görünmez, titremeyi önler).
 */
export function triangle(a: Vec3, b: Vec3, c: Vec3, thickness: number, block: string, source: string, sink: PartSink): void {
  if (length(cross(sub(b, a), sub(c, a))) < EPS) throw new GeometryError(`${source}: the triangle has zero area (collinear points).`)
  const corners: [Vec3, Vec3, Vec3][] = [[a, b, c], [b, c, a], [c, a, b]]
  corners.forEach(([p, q, r], k) => {
    const e1 = scale(sub(q, p), 0.5)
    const e2 = scale(sub(r, p), 0.5)
    sink.push(parallelogram(p, e1, e2, thickness + 2 * k * Z_FIGHT_STEP, block, `${source} part ${k + 1}/3`))
  })
}

/** Dört nokta düzlemsel bir paralelkenar mı (p0 + p2 = p1 + p3)? */
export function isParallelogram(p: readonly Vec3[], tolerance: number): boolean {
  return p.length === 4 && distance(add(p[0], p[2]), add(p[1], p[3])) <= tolerance
}

/**
 * Dolu çokgen. Paralelkenar → 1 parça; yamuk → paralelkenar + üçgen (4 parça);
 * diğerleri üçgenlere bölünür (üçgen başına 3 parça).
 */
export function filledPolygon(points: readonly Vec3[], thickness: number, block: string, source: string, sink: PartSink, tolerance: number): void {
  const pts = dedupe(points, true)
  if (pts.length < 3) throw new GeometryError(`${source}: needs at least 3 distinct points.`)
  const plane = fitPlane(pts, source, tolerance)
  if (pts.length === 3) {
    triangle(pts[0], pts[1], pts[2], thickness, block, source, sink)
    return
  }
  if (isParallelogram(pts, tolerance)) {
    sink.push(parallelogram(pts[0], sub(pts[1], pts[0]), sub(pts[3], pts[0]), thickness, block, source))
    return
  }
  if (pts.length === 4 && trapezoid(pts, thickness, block, source, sink)) return
  triangulate(pts, plane.normal, source).forEach(([i, j, k], index) =>
    triangle(pts[i], pts[j], pts[k], thickness, block, `${source} triangle ${index + 1}`, sink)
  )
}

/**
 * Dışbükey yamuk (bir çift kenarı paralel, aynı yönde değil karşılıklı): uzun kenardan kısa kenar boyunda
 * bir paralelkenar ayrılır, kalan üçgen ayrıca çizilir. Yamuk değilse `false`.
 */
function trapezoid(p: readonly Vec3[], thickness: number, block: string, source: string, sink: PartSink): boolean {
  for (const shift of [0, 1]) {
    const [a, b, c, d] = [p[shift], p[shift + 1], p[(shift + 2) % 4], p[(shift + 3) % 4]]
    // ab ∥ dc ve aynı yönde mi?
    const ab = sub(b, a)
    const dc = sub(c, d)
    if (length(cross(ab, dc)) > 1e-9 * Math.max(1, length(ab) * length(dc)) || dot(ab, dc) <= 0) continue
    const [long, short] = length(ab) >= length(dc) ? [[a, b, c, d], dc] as const : [[d, c, b, a], ab] as const
    const [p0, p1, p2, p3] = long
    // p0, p0+short, p2 (ya da p1), p3 paralelkenarı; kalan üçgen (p0+short, p1, p2)
    const corner = add(p0, short)
    sink.push(parallelogram(p0, short, sub(p3, p0), thickness, block, `${source} part 1/4`))
    triangle(corner, p1, p2, thickness + 2 * Z_FIGHT_STEP, block, `${source} triangle`, sink)
    return true
  }
  return false
}

/** Newell normali ve düzlemsellik denetimi. */
export function fitPlane(points: readonly Vec3[], source: string, tolerance: number): { normal: Vec3; center: Vec3 } {
  let nx = 0
  let ny = 0
  let nz = 0
  let center: Vec3 = [0, 0, 0]
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    nx += (p[1] - q[1]) * (p[2] + q[2])
    ny += (p[2] - q[2]) * (p[0] + q[0])
    nz += (p[0] - q[0]) * (p[1] + q[1])
    center = add(center, p)
  }
  center = scale(center, 1 / points.length)
  const raw: Vec3 = [nx, ny, nz]
  if (length(raw) < EPS) throw new GeometryError(`${source}: the points do not span a plane (zero area).`)
  const normal = normalize(raw)
  for (const [index, p] of points.entries()) {
    const off = Math.abs(dot(sub(p, center), normal))
    if (off > tolerance) {
      throw new GeometryError(`${source}: point ${index + 1} is ${off.toFixed(4)} blocks off the polygon's plane; split it into planar polygons or triangles.`)
    }
  }
  return { normal, center }
}

/** Kulak kırpma (ear clipping); basit (kendini kesmeyen) çokgenlerde, içbükey olanlar dahil çalışır. */
export function triangulate(points: readonly Vec3[], normal: Vec3, source: string): [number, number, number][] {
  const u = anyPerpendicular(normal)
  const v = cross(normal, u)
  const p2 = points.map((p) => [dot(p, u), dot(p, v)] as const)
  // Çokgen saat yönündeyse v ekseni çevrilir; böylece her iki yönde de saat yönünün tersi işlenir
  let signed = 0
  for (let i = 0; i < p2.length; i++) {
    const [x1, y1] = p2[i]
    const [x2, y2] = p2[(i + 1) % p2.length]
    signed += x1 * y2 - x2 * y1
  }
  const flip = signed < 0 ? -1 : 1
  const area2 = (a: number, b: number, c: number): number =>
    flip * ((p2[b][0] - p2[a][0]) * (p2[c][1] - p2[a][1]) - (p2[b][1] - p2[a][1]) * (p2[c][0] - p2[a][0]))
  const indices = points.map((_, i) => i)
  const result: [number, number, number][] = []
  const scaleRef = Math.max(...p2.map(([x, y]) => Math.abs(x) + Math.abs(y)), 1)
  const eps = 1e-12 * scaleRef * scaleRef
  let guard = 0
  while (indices.length > 3) {
    if (guard++ > points.length * points.length) throw new GeometryError(`${source}: the polygon is self-intersecting and cannot be filled.`)
    let clipped = false
    for (let i = 0; i < indices.length; i++) {
      const a = indices[(i - 1 + indices.length) % indices.length]
      const b = indices[i]
      const c = indices[(i + 1) % indices.length]
      if (area2(a, b, c) <= eps) continue // dışbükey değil
      const inside = indices.some((k) => {
        if (k === a || k === b || k === c) return false
        return area2(a, b, k) >= -eps && area2(b, c, k) >= -eps && area2(c, a, k) >= -eps
      })
      if (inside) continue
      result.push([a, b, c])
      indices.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) {
      // Yalnızca eş doğrusal kalıntılar kaldıysa onları at
      const flat = indices.findIndex((b, i) => Math.abs(area2(indices[(i - 1 + indices.length) % indices.length], b, indices[(i + 1) % indices.length])) <= eps)
      if (flat < 0) throw new GeometryError(`${source}: the polygon is self-intersecting and cannot be filled.`)
      indices.splice(flat, 1)
    }
  }
  if (indices.length === 3 && Math.abs(area2(indices[0], indices[1], indices[2])) > eps) result.push([indices[0], indices[1], indices[2]])
  return result
}

// --- Eğriler ---

/**
 * Düzlemin açı tabanı: 0° yönü `u`, 90° yönü `v = n × u`. Normal dikeyse `u = +x`; değilse `u` yataydır
 * (`+y × n`). Normal +y iken v = -z olur: yukarıdan bakınca açılar saat yönünün tersine artar.
 */
export function planeBasis(normal: Vec3): { u: Vec3; v: Vec3; n: Vec3 } {
  const n = normalize(normal)
  const u: Vec3 = Math.abs(n[1]) > 1 - 1e-9 ? [1, 0, 0] : normalize(cross([0, 1, 0], n))
  return { u, v: cross(n, u), n }
}

/** Yarıçapı `r` olan yayı, kiriş sapması (sagitta) `tolerance`'ı aşmayacak kadar parçaya böler. */
export function arcSegments(radius: number, sweepRadians: number, tolerance: number, minimum = 3): number {
  if (tolerance >= radius) return Math.max(minimum, Math.ceil(Math.abs(sweepRadians) / (Math.PI / 2)))
  const step = 2 * Math.acos(1 - tolerance / radius)
  return Math.max(minimum, Math.ceil(Math.abs(sweepRadians) / step))
}

export function ellipsePoint(center: Vec3, basis: { u: Vec3; v: Vec3 }, rx: number, ry: number, angle: number): Vec3 {
  return add(center, add(scale(basis.u, rx * Math.cos(angle)), scale(basis.v, ry * Math.sin(angle))))
}

/** Bezier eğrisi (herhangi bir derece), de Casteljau ile. */
export function bezierPoint(control: readonly Vec3[], t: number): Vec3 {
  // Yerinde hesaplanır: çok noktalı eğride her seviyede yeni dizi ayırmak örneklemeyi yavaşlatır
  const xs = control.map((p) => p[0])
  const ys = control.map((p) => p[1])
  const zs = control.map((p) => p[2])
  for (let n = control.length - 1; n > 0; n--) {
    for (let i = 0; i < n; i++) {
      xs[i] += (xs[i + 1] - xs[i]) * t
      ys[i] += (ys[i + 1] - ys[i]) * t
      zs[i] += (zs[i + 1] - zs[i]) * t
    }
  }
  return [xs[0], ys[0], zs[0]]
}

/**
 * Örnek sayısı üst sınırı; çok küçük tolerance ve çok noktalı eğride örnekleme uzun sürmesin.
 * Sahnenin parça sınırından (4000) büyük olduğu için bu kadar örnekli eğri zaten reddedilir.
 */
const MAX_BEZIER_SAMPLES = 4096

/**
 * Bezier'i, her parçanın eğriden sapması `tolerance`'ı aşmayana kadar ikiye bölerek örnekler.
 * Sapma, aralığın içindeki birkaç noktanın kirişe uzaklığıyla ölçülür.
 */
export function sampleBezier(control: readonly Vec3[], tolerance: number): Vec3[] {
  const out: Vec3[] = [bezierPoint(control, 0)]
  const recurse = (t0: number, t1: number, p0: Vec3, p1: Vec3, depth: number): void => {
    if (out.length >= MAX_BEZIER_SAMPLES) {
      out.push(p1)
      return
    }
    let worst = 0
    for (const f of [0.25, 0.5, 0.75]) {
      const q = bezierPoint(control, t0 + (t1 - t0) * f)
      worst = Math.max(worst, distanceToSegment(q, p0, p1))
    }
    if (worst <= tolerance || depth >= 16) {
      out.push(p1)
      return
    }
    const tm = (t0 + t1) / 2
    const pm = bezierPoint(control, tm)
    recurse(t0, tm, p0, pm, depth + 1)
    recurse(tm, t1, pm, p1, depth + 1)
  }
  // Kapalı ya da S biçimli eğrilerde uçlar kirişi yanıltmasın diye en az 4 parçadan başlanır
  const starts = [0, 0.25, 0.5, 0.75, 1]
  for (let i = 0; i < 4; i++) recurse(starts[i], starts[i + 1], bezierPoint(control, starts[i]), bezierPoint(control, starts[i + 1]), 0)
  return out
}

export function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a)
  const len2 = dot(ab, ab)
  if (len2 === 0) return distance(p, a)
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2))
  return distance(p, add(a, scale(ab, t)))
}
