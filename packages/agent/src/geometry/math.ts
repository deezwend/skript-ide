/**
 * Display geometrisi için küçük, bağımlılıksız lineer cebir: 3B vektör, satır öncelikli 3×3 matris,
 * birim kuaternion ve 3×3 SVD. Hesaplar `double` ile yapılır; Minecraft'ın `float` yuvarlaması
 * yalnızca doğrulamada (`verify`) taklit edilir.
 */

export type Vec3 = readonly [number, number, number]
/** Satır öncelikli: `[m00, m01, m02, m10, …, m22]`. Sütunlar küpün eksenlerinin dönüştüğü vektörlerdir. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]
/** Hamilton kuaternionu; Skript'te `quaternion(w, x, y, z)`, JOML'da `Quaternionf(x, y, z, w)`. */
export interface Quat {
  w: number
  x: number
  y: number
  z: number
}

export const ZERO: Vec3 = [0, 0, 0]
export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
export const IDENTITY_QUAT: Quat = { w: 1, x: 0, y: 0, z: 0 }

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b))
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t))
export const midpoint = (a: Vec3, b: Vec3): Vec3 => lerp(a, b, 0.5)

export function normalize(a: Vec3): Vec3 {
  const len = length(a)
  if (len === 0) throw new RangeError('Cannot normalize a zero vector.')
  return scale(a, 1 / len)
}

/** `a`'ya dik herhangi bir birim vektör; sonuç kararlıdır (en küçük bileşenin ekseni seçilir). */
export function anyPerpendicular(a: Vec3): Vec3 {
  const ax = Math.abs(a[0])
  const ay = Math.abs(a[1])
  const az = Math.abs(a[2])
  const axis: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  return normalize(cross(a, axis))
}

/** Sütunlardan matris: `M·e_i = c_i`. */
export function fromColumns(c0: Vec3, c1: Vec3, c2: Vec3): Mat3 {
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]]
}

export function column(m: Mat3, i: 0 | 1 | 2): Vec3 {
  return [m[i], m[3 + i], m[6 + i]]
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
}

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9)
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  }
  return r as unknown as Mat3
}

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ]
}

export function det(m: Mat3): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
}

export function diag(s: Vec3): Mat3 {
  return [s[0], 0, 0, 0, s[1], 0, 0, 0, s[2]]
}

// --- Kuaternion ---

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q.w, q.x, q.y, q.z)
  if (n === 0) throw new RangeError('Cannot normalize a zero quaternion.')
  // İşaret kanonikleştirilir (w ≥ 0); q ile -q aynı dönüştür, çıktı kararlı olsun
  const k = q.w < 0 ? -1 / n : 1 / n
  return { w: q.w * k, x: q.x * k, y: q.y * k, z: q.z * k }
}

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
  }
}

/** Birim eksen etrafında radyan cinsinden açı (sağ el kuralı). */
export function quatAxisAngle(axis: Vec3, radians: number): Quat {
  const [x, y, z] = normalize(axis)
  const s = Math.sin(radians / 2)
  return quatNormalize({ w: Math.cos(radians / 2), x: x * s, y: y * s, z: z * s })
}

/** `from` yönünü `to` yönüne çeviren en kısa dönüş. */
export function quatFromTo(from: Vec3, to: Vec3): Quat {
  const a = normalize(from)
  const b = normalize(to)
  const d = dot(a, b)
  if (d < -1 + 1e-12) return quatAxisAngle(anyPerpendicular(a), Math.PI)
  const c = cross(a, b)
  return quatNormalize({ w: 1 + d, x: c[0], y: c[1], z: c[2] })
}

/** Kuaternionun döndürme matrisi; normalize edilmemiş girdide de JOML gibi ölçeklenmiş sonuç verir. */
export function quatToMat(q: Quat): Mat3 {
  const { w, x, y, z } = q
  return [
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z
  ]
}

/** Döndürme matrisinden kuaternion (Shepperd yöntemi; her durumda sayısal olarak kararlı). */
export function matToQuat(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m
  const trace = m00 + m11 + m22
  let q: Quat
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    q = { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s }
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    q = { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s }
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s }
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 }
  }
  return quatNormalize(q)
}

// --- SVD ---

export interface Svd {
  /** Döndürme (det = +1). */
  u: Mat3
  /** Büyükten küçüğe tekil değerler; `det(M) > 0` ise hepsi ≥ 0. */
  sigma: Vec3
  /** Döndürme (det = +1); `M = U · diag(sigma) · Vᵀ`. */
  v: Mat3
}

/** Simetrik 3×3 matrisin özdeğer/özvektörleri (döngüsel Jacobi). Sütunlar özvektörlerdir. */
function symmetricEigen(a: Mat3): { values: Vec3; vectors: Mat3 } {
  const m = [...a]
  const v = [...IDENTITY]
  for (let sweep = 0; sweep < 64; sweep++) {
    const off = Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[5])
    const scaleRef = Math.abs(m[0]) + Math.abs(m[4]) + Math.abs(m[8])
    if (off <= 1e-30 || off <= 1e-17 * scaleRef) break
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = m[p * 3 + q]
      if (apq === 0) continue
      const app = m[p * 3 + p]
      const aqq = m[q * 3 + q]
      const theta = (aqq - app) / (2 * apq)
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c
      // m ← Jᵀ m J
      for (let k = 0; k < 3; k++) {
        const mkp = m[k * 3 + p]
        const mkq = m[k * 3 + q]
        m[k * 3 + p] = c * mkp - s * mkq
        m[k * 3 + q] = s * mkp + c * mkq
      }
      for (let k = 0; k < 3; k++) {
        const mpk = m[p * 3 + k]
        const mqk = m[q * 3 + k]
        m[p * 3 + k] = c * mpk - s * mqk
        m[q * 3 + k] = s * mpk + c * mqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p]
        const vkq = v[k * 3 + q]
        v[k * 3 + p] = c * vkp - s * vkq
        v[k * 3 + q] = s * vkp + c * vkq
      }
    }
  }
  return { values: [m[0], m[4], m[8]], vectors: v as unknown as Mat3 }
}

/**
 * `M = U·Σ·Vᵀ`; U ve V her zaman gerçek döndürmedir (det = +1). `det(M) < 0` ise yansıma Σ'nın son
 * bileşeninin işaretine taşınır (negatif ölçek). Tekil (düz) matrislerde eksik eksenler çapraz çarpımla tamamlanır.
 */
export function svd(m: Mat3): Svd {
  const { values, vectors } = symmetricEigen(mul(transpose(m), m))
  const order = [0, 1, 2].sort((i, j) => values[j] - values[i]) as (0 | 1 | 2)[]
  const vCols = order.map((i) => column(vectors, i))
  const sigma = order.map((i) => Math.sqrt(Math.max(values[i], 0)))
  // V'yi döndürme yap
  vCols[2] = cross(vCols[0], vCols[1])

  const maxSigma = sigma[0]
  const tiny = Math.max(maxSigma, 1e-300) * 1e-12
  const uCols: Vec3[] = []
  for (let i = 0; i < 3; i++) {
    if (sigma[i] > tiny) uCols.push(scale(apply(m, vCols[i]), 1 / sigma[i]))
    else if (i === 0) uCols.push([1, 0, 0])
    else if (i === 1) uCols.push(anyPerpendicular(uCols[0]))
    else uCols.push(cross(uCols[0], uCols[1]))
  }
  // Sayısal kaymayı temizle: Gram–Schmidt, sonra sağ el sistemi
  const u0 = normalize(uCols[0])
  const u1 = normalize(sub(uCols[1], scale(u0, dot(uCols[1], u0))))
  const u2 = cross(u0, u1)
  const s2 = sigma[2] > tiny ? dot(apply(m, vCols[2]), u2) : 0
  return {
    u: fromColumns(u0, u1, u2),
    sigma: [sigma[0], sigma[1], s2],
    v: fromColumns(vCols[0], vCols[1], vCols[2])
  }
}

// --- Biçimlendirme ---

/** Gereksiz sıfırları atan sabit ondalık yazım; `-0` → `0`. */
export function formatNumber(value: number, decimals = 6): string {
  const fixed = value.toFixed(decimals)
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  return trimmed === '-0' ? '0' : trimmed
}

export function roundTo(value: number, decimals: number): number {
  const k = 10 ** decimals
  const r = Math.round(value * k) / k
  return r === 0 ? 0 : r
}
