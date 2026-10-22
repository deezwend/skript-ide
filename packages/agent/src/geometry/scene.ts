/**
 * Bildirimsel sahne tanımı → block display parçaları. LLM yalnızca şekilleri tarif eder;
 * tüm koordinat, açı ve dönüşüm hesapları burada yapılır.
 */

import {
  add,
  cross,
  length,
  normalize,
  quatAxisAngle,
  quatToMat,
  scale,
  sub,
  type Vec3
} from './math'
import {
  arcSegments,
  box,
  ellipsePoint,
  filledPolygon,
  GeometryError,
  planeBasis,
  polyline,
  sampleBezier,
  segment,
  triangle,
  type Part
} from './shapes'

export interface SceneDefaults {
  block: string
  /** Levha (üçgen, çokgen, daire) kalınlığı. */
  thickness: number
  /** Çizgi kalınlığı. */
  width: number
  /** Eğrilerin gerçek şekilden en fazla sapması (blok). */
  tolerance: number
}

export const DEFAULTS: SceneDefaults = { block: 'white_concrete', thickness: 0.05, width: 0.1, tolerance: 0.01 }
/** Düzlemsellik ve eşitlik denetimleri için (blok). */
const PLANAR_TOLERANCE = 1e-3
export const MAX_PARTS = 4000
export const WARN_PARTS = 400

export type RawShape = Record<string, unknown>

export interface MeshData {
  vertices: Vec3[]
  faces: number[][]
}

export interface CompileOptions {
  /** `obj` şekilleri için proje dosyasını okuyup ayrıştırır; verilmezse `obj` desteklenmez. */
  loadObj?: (path: string) => Promise<MeshData>
}

export interface CompiledScene {
  parts: Part[]
  warnings: string[]
  /** Şekil başına parça sayısı, rapor için. */
  summary: string[]
}

export async function compileScene(input: {
  shapes: RawShape[]
  block?: string
  thickness?: number
  width?: number
  tolerance?: number
}, options: CompileOptions = {}): Promise<CompiledScene> {
  const defaults: SceneDefaults = {
    block: input.block ?? DEFAULTS.block,
    thickness: positive(input.thickness ?? DEFAULTS.thickness, 'thickness'),
    width: positive(input.width ?? DEFAULTS.width, 'width'),
    tolerance: positive(input.tolerance ?? DEFAULTS.tolerance, 'tolerance')
  }
  if (!Array.isArray(input.shapes) || input.shapes.length === 0) throw new GeometryError('shapes must contain at least one shape.')
  const parts: Part[] = []
  const warnings: string[] = []
  const summary: string[] = []
  for (const [index, raw] of input.shapes.entries()) {
    const before = parts.length
    const label = `shapes[${index}] (${String(raw.type)})`
    await compileShape(raw, label, defaults, { push: (part) => parts.push(part) }, warnings, options)
    if (parts.length > MAX_PARTS) throw new GeometryError(`The scene needs more than ${MAX_PARTS} block displays; increase tolerance, use fewer/lower-resolution shapes or split it.`)
    summary.push(`${label}: ${parts.length - before} displays`)
  }
  if (parts.length > WARN_PARTS) warnings.push(`${parts.length} block displays is a lot for clients to render; consider a larger tolerance.`)
  return { parts, warnings, summary }
}

async function compileShape(
  raw: RawShape,
  label: string,
  defaults: SceneDefaults,
  sink: { push(part: Part): void },
  warnings: string[],
  options: CompileOptions
): Promise<void> {
  const r = new Reader(raw, label)
  const block = r.string('block') ?? defaults.block
  const thickness = r.positive('thickness') ?? defaults.thickness
  const width = r.positive('width') ?? defaults.width
  const tolerance = r.positive('tolerance') ?? defaults.tolerance
  switch (r.string('type')) {
    case 'box': {
      const rotation = r.rotation()
      const from = r.vec('from')
      const to = r.vec('to')
      let center: Vec3
      let size: Vec3
      if (from && to) {
        center = scale(add(from, to), 0.5)
        size = sub(to, from).map(Math.abs) as unknown as Vec3
      } else {
        center = r.requireVec('center')
        size = r.requireVec('size')
      }
      if (size.some((s) => s <= 0)) throw new GeometryError(`${label}: every size component must be positive.`)
      const m = quatToMat(rotation)
      sink.push(box(center, size, [[m[0], m[3], m[6]], [m[1], m[4], m[7]], [m[2], m[5], m[8]]], block, label))
      return
    }
    case 'line':
      sink.push(segment(r.requireVec('from'), r.requireVec('to'), width, block, label, {
        extendStart: r.cap() === 'square' ? width / 2 : 0,
        extendEnd: r.cap() === 'square' ? width / 2 : 0,
        normal: r.vec('normal')
      }))
      return
    case 'polyline':
      polyline(r.points('points', 2), { width, closed: r.boolean('closed') ?? false, cap: r.cap(), normal: r.vec('normal') }, block, label, sink)
      return
    case 'triangle': {
      const [a, b, c] = r.points('points', 3, 3)
      triangle(a, b, c, thickness, block, label, sink)
      return
    }
    case 'polygon': {
      const points = r.points('points', 3)
      if (r.boolean('fill') ?? true) filledPolygon(points, thickness, block, label, sink, PLANAR_TOLERANCE)
      else polyline(points, { width, closed: true, normal: polygonNormal(points) }, block, label, sink)
      return
    }
    case 'circle': {
      const center = r.requireVec('center')
      const radius = r.requirePositive('radius')
      const radius2 = r.positive('radius2') ?? radius
      const basis = planeBasis(r.vec('normal') ?? [0, 1, 0])
      const start = degrees(r.number('start_angle') ?? 0)
      const end = degrees(r.number('end_angle') ?? 360)
      const sweep = end - start
      if (sweep === 0 || Math.abs(sweep) > 2 * Math.PI + 1e-9) throw new GeometryError(`${label}: end_angle - start_angle must be in (-360, 360] and not 0.`)
      const full = Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-9
      // Elipste en büyük eğrilik küçük eksenin ucunda: r_eğrilik = b²/a
      const curvatureRadius = Math.min(radius, radius2) ** 2 / Math.max(radius, radius2)
      const fill = r.boolean('fill') ?? false
      let n = arcSegments(curvatureRadius, sweep, tolerance, full ? 8 : 2)
      if (full && n % 2) n++
      const at = (k: number): Vec3 => ellipsePoint(center, basis, radius, radius2, start + (sweep * k) / n)
      if (!fill) {
        const pts = Array.from({ length: full ? n : n + 1 }, (_, k) => at(k))
        polyline(pts, { width, closed: full, normal: basis.n, cap: r.cap() }, block, label, sink)
      } else if (full) {
        // Eksene dik paralel kirişlerle şeritler: her şerit yamuk (4 parça) ya da uçlarda üçgen (3 parça)
        for (let k = 0; k < n / 2; k++) {
          const strip = [at(k), at(k + 1), at(n - k - 1), at(n - k)]
          filledPolygon(strip, thickness, block, `${label} strip ${k + 1}`, sink, PLANAR_TOLERANCE)
        }
      } else {
        for (let k = 0; k < n; k++) triangle(center, at(k), at(k + 1), thickness, block, `${label} slice ${k + 1}`, sink)
      }
      return
    }
    case 'curve': {
      const control = r.points('points', 2)
      const pts = sampleBezier(control, tolerance)
      polyline(pts, { width, cap: r.cap(), normal: r.vec('normal') }, block, label, sink)
      return
    }
    case 'cylinder': {
      const from = r.requireVec('from')
      const to = r.requireVec('to')
      const radius = r.requirePositive('radius')
      const axis = sub(to, from)
      if (length(axis) === 0) throw new GeometryError(`${label}: from and to are the same point.`)
      const basis = planeBasis(axis)
      let n = arcSegments(radius, 2 * Math.PI, tolerance, 6)
      if (n % 2) n++
      // Yan yüzler: her biri düzlemsel dikdörtgen (1 parça); kalınlık kirişin ortasına
      for (let k = 0; k < n; k++) {
        const a = ellipsePoint(from, basis, radius, radius, (2 * Math.PI * k) / n)
        const b = ellipsePoint(from, basis, radius, radius, (2 * Math.PI * (k + 1)) / n)
        filledPolygon([a, b, add(b, axis), add(a, axis)], thickness, block, `${label} side ${k + 1}`, sink, PLANAR_TOLERANCE)
      }
      if (r.boolean('caps') ?? true) {
        for (const [end, name] of [[from, 'bottom'], [to, 'top']] as const) {
          const at = (k: number): Vec3 => ellipsePoint(end, basis, radius, radius, (2 * Math.PI * k) / n)
          for (let k = 0; k < n / 2; k++) {
            filledPolygon([at(k), at(k + 1), at(n - k - 1), at(n - k)], thickness, block, `${label} ${name} strip ${k + 1}`, sink, PLANAR_TOLERANCE)
          }
        }
      }
      return
    }
    case 'sphere': {
      const center = r.requireVec('center')
      const radius = r.requirePositive('radius')
      const lon = evenUp(arcSegments(radius, 2 * Math.PI, tolerance, 8))
      const lat = Math.max(2, Math.ceil(lon / 2))
      const point = (i: number, j: number): Vec3 => {
        const phi = (Math.PI * i) / lat
        const theta = (2 * Math.PI * j) / lon
        return add(center, [radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), -radius * Math.sin(phi) * Math.sin(theta)])
      }
      for (let i = 0; i < lat; i++) {
        for (let j = 0; j < lon; j++) {
          const quad = [point(i, j), point(i + 1, j), point(i + 1, j + 1), point(i, j + 1)]
          filledPolygon(quad, thickness, block, `${label} face ${i + 1}.${j + 1}`, sink, PLANAR_TOLERANCE)
        }
      }
      warnings.push(`${label}: a sphere is approximated by flat faces (${lon}×${lat}); maximum deviation ≈ ${tolerance} blocks.`)
      return
    }
    case 'mesh': {
      const vertices = r.points('vertices', 3)
      const faces = r.faces(vertices.length)
      emitMesh({ vertices, faces }, thickness, block, label, sink)
      return
    }
    case 'obj': {
      if (!options.loadObj) throw new GeometryError(`${label}: obj files are not supported here.`)
      const path = r.string('path')
      if (!path) throw new GeometryError(`${label}: path is required.`)
      const mesh = await options.loadObj(path)
      const k = r.positive('scale') ?? 1
      const offset = r.vec('offset') ?? [0, 0, 0]
      const rotation = quatToMat(r.rotation())
      const vertices = mesh.vertices.map((v) => {
        const s = scale(v, k)
        return add(offset, [
          rotation[0] * s[0] + rotation[1] * s[1] + rotation[2] * s[2],
          rotation[3] * s[0] + rotation[4] * s[1] + rotation[5] * s[2],
          rotation[6] * s[0] + rotation[7] * s[1] + rotation[8] * s[2]
        ])
      })
      emitMesh({ vertices, faces: mesh.faces }, thickness, block, label, sink)
      return
    }
    default:
      throw new GeometryError(
        `${label}: unknown type. Use one of: box, line, polyline, triangle, polygon, circle, curve, cylinder, sphere, mesh, obj.`
      )
  }
}

function emitMesh(mesh: MeshData, thickness: number, block: string, label: string, sink: { push(part: Part): void }): void {
  for (const [index, face] of mesh.faces.entries()) {
    const pts = face.map((i) => {
      const v = mesh.vertices[i]
      if (!v) throw new GeometryError(`${label}: face ${index + 1} uses vertex ${i + 1}, which does not exist.`)
      return v
    })
    filledPolygon(pts, thickness, block, `${label} face ${index + 1}`, sink, PLANAR_TOLERANCE)
  }
}

/** Basit OBJ ayrıştırıcı: `v` ve `f` satırları (1 tabanlı ya da negatif indeksler, `a/b/c` biçimi). */
export function parseObj(text: string): MeshData {
  const vertices: Vec3[] = []
  const faces: number[][] = []
  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (line.startsWith('v ')) {
      const nums = line.slice(2).trim().split(/\s+/).slice(0, 3).map(Number)
      if (nums.length < 3 || nums.some((n) => !Number.isFinite(n))) throw new GeometryError(`OBJ line ${lineIndex + 1}: invalid vertex.`)
      vertices.push(nums as unknown as Vec3)
    } else if (line.startsWith('f ')) {
      const face = line.slice(2).trim().split(/\s+/).map((token) => {
        const n = parseInt(token.split('/')[0], 10)
        if (!Number.isInteger(n) || n === 0) throw new GeometryError(`OBJ line ${lineIndex + 1}: invalid face index.`)
        return n > 0 ? n - 1 : vertices.length + n
      })
      if (face.length < 3) throw new GeometryError(`OBJ line ${lineIndex + 1}: a face needs at least 3 vertices.`)
      faces.push(face)
    }
  }
  if (!faces.length) throw new GeometryError('The OBJ file has no faces.')
  return { vertices, faces }
}

function polygonNormal(points: readonly Vec3[]): Vec3 | undefined {
  for (let i = 2; i < points.length; i++) {
    const n = cross(sub(points[1], points[0]), sub(points[i], points[0]))
    if (length(n) > 1e-9) return normalize(n)
  }
  return undefined
}

const degrees = (value: number): number => (value * Math.PI) / 180
const evenUp = (n: number): number => (n % 2 ? n + 1 : n)

function positive(value: number, name: string): number {
  if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) throw new GeometryError(`${name} must be a positive number.`)
  return value
}

/** Şekil alanlarını tür denetimiyle okur; hatalar LLM'in düzeltebileceği açıklıkta olur. */
class Reader {
  constructor(private readonly raw: RawShape, private readonly label: string) {}

  private get(key: string): unknown {
    return this.raw[key]
  }

  string(key: string): string | undefined {
    const value = this.get(key)
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value.trim()) throw new GeometryError(`${this.label}: ${key} must be a non-empty string.`)
    return value.trim()
  }

  number(key: string): number | undefined {
    const value = this.get(key)
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new GeometryError(`${this.label}: ${key} must be a number.`)
    return value
  }

  positive(key: string): number | undefined {
    const value = this.number(key)
    if (value !== undefined && value <= 0) throw new GeometryError(`${this.label}: ${key} must be positive.`)
    return value
  }

  requirePositive(key: string): number {
    const value = this.positive(key)
    if (value === undefined) throw new GeometryError(`${this.label}: ${key} is required.`)
    return value
  }

  boolean(key: string): boolean | undefined {
    const value = this.get(key)
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new GeometryError(`${this.label}: ${key} must be true or false.`)
    return value
  }

  cap(): 'flat' | 'square' {
    const value = this.string('cap') ?? 'flat'
    if (value !== 'flat' && value !== 'square') throw new GeometryError(`${this.label}: cap must be "flat" or "square".`)
    return value
  }

  vec(key: string): Vec3 | undefined {
    const value = this.get(key)
    if (value === undefined) return undefined
    return toVec(value, `${this.label}: ${key}`)
  }

  requireVec(key: string): Vec3 {
    const value = this.vec(key)
    if (!value) throw new GeometryError(`${this.label}: ${key} is required.`)
    return value
  }

  points(key: string, min: number, max = Infinity): Vec3[] {
    const value = this.get(key)
    if (!Array.isArray(value)) throw new GeometryError(`${this.label}: ${key} must be an array of [x, y, z] points.`)
    if (value.length < min || value.length > max) {
      throw new GeometryError(`${this.label}: ${key} needs ${max === min ? `exactly ${min}` : `at least ${min}`} points, got ${value.length}.`)
    }
    return value.map((point, i) => toVec(point, `${this.label}: ${key}[${i}]`))
  }

  faces(vertexCount: number): number[][] {
    const value = this.get('faces')
    if (!Array.isArray(value) || !value.length) throw new GeometryError(`${this.label}: faces must be a non-empty array of vertex index lists.`)
    return value.map((face, i) => {
      if (!Array.isArray(face) || face.length < 3 || !face.every((n) => Number.isInteger(n) && n >= 0 && n < vertexCount)) {
        throw new GeometryError(`${this.label}: faces[${i}] must list at least 3 vertex indices (0-based, < ${vertexCount}).`)
      }
      return face as number[]
    })
  }

  /** `axis` + `angle` (derece, sağ el kuralı); yoksa dönüşsüz. */
  rotation() {
    const axis = this.vec('axis')
    const angle = this.number('angle')
    if (angle === undefined || angle === 0) return { w: 1, x: 0, y: 0, z: 0 }
    return quatAxisAngle(axis ?? [0, 1, 0], degrees(angle))
  }
}

export function toVec(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new GeometryError(`${label} must be [x, y, z] with three numbers.`)
  }
  return value as unknown as Vec3
}
