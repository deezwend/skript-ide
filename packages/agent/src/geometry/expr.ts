/**
 * `math_eval` için güvenli hesap dili: sayılar, vektörler (`[x, y, z]`), değişkenler ve geometri fonksiyonları.
 * `eval` kullanılmaz; kendi ayrıştırıcısıyla yalnızca aşağıdaki işlemleri yapar.
 */

import {
  cross,
  dot,
  length,
  normalize,
  quatAxisAngle,
  quatFromTo,
  quatMul,
  quatNormalize,
  quatToMat,
  apply,
  type Quat,
  type Vec3
} from './math'

export type Value = number | number[]

export class ExprError extends Error {}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'id'; value: string }
  | { kind: 'op'; value: string }

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const re = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/%^(),;=[\]\n]))/y
  let index = 0
  while (index < source.length) {
    if (/^[ \t\r]*$/.test(source.slice(index))) break
    re.lastIndex = index
    const match = re.exec(source)
    if (!match) throw new ExprError(`Unexpected character "${source.slice(index).trimStart()[0]}" at position ${index + 1}.`)
    index = re.lastIndex
    if (match[1] !== undefined) tokens.push({ kind: 'num', value: Number(match[1]) })
    else if (match[2] !== undefined) tokens.push({ kind: 'id', value: match[2] })
    else tokens.push({ kind: 'op', value: match[3] === '**' ? '^' : match[3] === '\n' ? ';' : match[3] })
  }
  return tokens
}

const RAD = Math.PI / 180

const CONSTANTS: Record<string, number> = { pi: Math.PI, tau: 2 * Math.PI, e: Math.E }

const num = (v: Value, name: string): number => {
  if (typeof v !== 'number') throw new ExprError(`${name} expects a number.`)
  return v
}
const vec = (v: Value, name: string, size = 3): number[] => {
  if (!Array.isArray(v) || v.length !== size) throw new ExprError(`${name} expects a ${size}-component vector.`)
  return v
}
const v3 = (v: Value, name: string): Vec3 => vec(v, name) as unknown as Vec3
const quat = (v: Value, name: string): Quat => {
  const [w, x, y, z] = vec(v, name, 4)
  return { w, x, y, z }
}
const quatValue = (q: Quat): number[] => [q.w, q.x, q.y, q.z]

/** Fonksiyon adı → (açıklama, uygulama). Açıklamalar tool tanımında listelenir. */
export const FUNCTIONS: Record<string, { doc: string; fn: (args: Value[]) => Value }> = {}

function define(names: string, doc: string, arity: number | [number, number], fn: (args: Value[]) => Value): void {
  for (const name of names.split(',')) {
    FUNCTIONS[name] = {
      doc,
      fn: (args) => {
        const [min, max] = Array.isArray(arity) ? arity : [arity, arity]
        if (args.length < min || args.length > max) throw new ExprError(`${name} takes ${min === max ? min : `${min}-${max}`} argument(s).`)
        return fn(args)
      }
    }
  }
}

const unary = (f: (x: number) => number) => (args: Value[]) => elementwise(args[0], f)

define('sin', 'radians', 1, unary(Math.sin))
define('cos', 'radians', 1, unary(Math.cos))
define('tan', 'radians', 1, unary(Math.tan))
define('sind', 'sine of degrees', 1, unary((x) => Math.sin(x * RAD)))
define('cosd', 'cosine of degrees', 1, unary((x) => Math.cos(x * RAD)))
define('tand', 'tangent of degrees', 1, unary((x) => Math.tan(x * RAD)))
define('asin', 'radians', 1, unary(Math.asin))
define('acos', 'radians', 1, unary(Math.acos))
define('atan', 'radians', 1, unary(Math.atan))
define('asind', 'degrees', 1, unary((x) => Math.asin(x) / RAD))
define('acosd', 'degrees', 1, unary((x) => Math.acos(x) / RAD))
define('atand', 'degrees', 1, unary((x) => Math.atan(x) / RAD))
define('atan2', 'atan2(y, x), radians', 2, ([y, x]) => Math.atan2(num(y, 'atan2'), num(x, 'atan2')))
define('atan2d', 'atan2d(y, x), degrees', 2, ([y, x]) => Math.atan2(num(y, 'atan2d'), num(x, 'atan2d')) / RAD)
define('rad', 'degrees → radians', 1, unary((x) => x * RAD))
define('deg', 'radians → degrees', 1, unary((x) => x / RAD))
define('sqrt', '', 1, unary(Math.sqrt))
define('cbrt', '', 1, unary(Math.cbrt))
define('abs', '', 1, unary(Math.abs))
define('floor', '', 1, unary(Math.floor))
define('ceil', '', 1, unary(Math.ceil))
define('exp', '', 1, unary(Math.exp))
define('ln', 'natural log', 1, unary(Math.log))
define('log10', '', 1, unary(Math.log10))
define('round', 'round(x, digits = 0)', [1, 2], ([x, d]) => {
  const k = 10 ** (d === undefined ? 0 : num(d, 'round'))
  return elementwise(x, (n) => Math.round(n * k) / k)
})
define('min', 'min(a, b, …)', [1, 64], (args) => Math.min(...args.map((a) => num(a, 'min'))))
define('max', 'max(a, b, …)', [1, 64], (args) => Math.max(...args.map((a) => num(a, 'max'))))
define('hypot', 'hypot(a, b, …)', [1, 64], (args) => Math.hypot(...args.map((a) => num(a, 'hypot'))))
define('sum', 'sum of a vector', 1, ([v]) => vecAny(v, 'sum').reduce((a, b) => a + b, 0))

define('dot', 'dot(a, b)', 2, ([a, b]) => dot(v3(a, 'dot'), v3(b, 'dot')))
define('cross', 'cross(a, b)', 2, ([a, b]) => [...cross(v3(a, 'cross'), v3(b, 'cross'))])
define('length,norm', 'vector length', 1, ([v]) => length(v3(v, 'length')))
define('normalize', 'unit vector', 1, ([v]) => [...normalize(v3(v, 'normalize'))])
define('dist', 'distance between points', 2, ([a, b]) => length(sub3(v3(a, 'dist'), v3(b, 'dist'))))
define('angle', 'angle between vectors, radians', 2, ([a, b]) => angleBetween(v3(a, 'angle'), v3(b, 'angle')))
define('angled', 'angle between vectors, degrees', 2, ([a, b]) => angleBetween(v3(a, 'angled'), v3(b, 'angled')) / RAD)
define('lerp', 'lerp(a, b, t)', 3, ([a, b, t]) => add(a, mulValues(sub(b, a), num(t, 'lerp'))))
define('mid', 'midpoint of two points', 2, ([a, b]) => mulValues(add(a, b), 0.5))
define('project', 'project(v, onto)', 2, ([v, onto]) => {
  const o = v3(onto, 'project')
  return [...o.map((c) => c * (dot(v3(v, 'project'), o) / dot(o, o)))]
})
define('rotate', 'rotate(v, axis, degrees): right-hand rule', 3, ([v, axis, d]) =>
  [...apply(quatToMat(quatAxisAngle(v3(axis, 'rotate'), num(d, 'rotate') * RAD)), v3(v, 'rotate'))]
)
define('quat_axis_angle', 'quat_axis_angle(axis, degrees) → [w, x, y, z]', 2, ([axis, d]) =>
  quatValue(quatAxisAngle(v3(axis, 'quat_axis_angle'), num(d, 'quat_axis_angle') * RAD))
)
define('quat_from_to', 'shortest rotation from a to b → [w, x, y, z]', 2, ([a, b]) => quatValue(quatFromTo(v3(a, 'quat_from_to'), v3(b, 'quat_from_to'))))
define('quat_mul', 'quat_mul(a, b): apply b, then a', 2, ([a, b]) => quatValue(quatMul(quat(a, 'quat_mul'), quat(b, 'quat_mul'))))
define('quat_rotate', 'quat_rotate(q, v)', 2, ([q, v]) => [...apply(quatToMat(quatNormalize(quat(q, 'quat_rotate'))), v3(v, 'quat_rotate'))])
define('quat_axis_angle_of', 'quaternion → [ax, ay, az, degrees]', 1, ([q]) => {
  const n = quatNormalize(quat(q, 'quat_axis_angle_of'))
  const s = Math.sqrt(Math.max(0, 1 - n.w * n.w))
  const angle = (2 * Math.acos(Math.min(1, n.w))) / RAD
  return s < 1e-12 ? [1, 0, 0, 0] : [n.x / s, n.y / s, n.z / s, angle]
})
define('mc_direction', 'mc_direction(yaw, pitch): Minecraft look vector', 2, ([yaw, pitch]) => {
  const y = num(yaw, 'mc_direction') * RAD
  const p = num(pitch, 'mc_direction') * RAD
  return [-Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)]
})
define('mc_yaw_pitch', 'direction → [yaw, pitch] (Minecraft degrees)', 1, ([v]) => {
  const [x, y, z] = normalize(v3(v, 'mc_yaw_pitch'))
  return [Math.atan2(-x, z) / RAD, -Math.asin(y) / RAD]
})

function vecAny(v: Value, name: string): number[] {
  if (!Array.isArray(v)) throw new ExprError(`${name} expects a vector.`)
  return v
}

function angleBetween(a: Vec3, b: Vec3): number {
  // atan2 ile küçük açılarda acos'tan daha hassas
  return Math.atan2(length(cross(a, b)), dot(a, b))
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

function elementwise(v: Value, f: (x: number) => number): Value {
  return Array.isArray(v) ? v.map(f) : f(v)
}

function binary(a: Value, b: Value, op: string, f: (x: number, y: number) => number): Value {
  if (typeof a === 'number' && typeof b === 'number') return f(a, b)
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) throw new ExprError(`"${op}" needs vectors of the same size (${a.length} vs ${b.length}).`)
    return a.map((x, i) => f(x, b[i]))
  }
  if (Array.isArray(a)) return a.map((x) => f(x, b as number))
  return (b as number[]).map((y) => f(a as number, y))
}

const add = (a: Value, b: Value): Value => binary(a, b, '+', (x, y) => x + y)
const sub = (a: Value, b: Value): Value => binary(a, b, '-', (x, y) => x - y)
const mulValues = (a: Value, b: Value): Value => binary(a, b, '*', (x, y) => x * y)

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[], private readonly vars: Map<string, Value>) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private isOp(value: string): boolean {
    const t = this.peek()
    return t?.kind === 'op' && t.value === value
  }

  private expect(value: string): void {
    if (!this.isOp(value)) throw new ExprError(`Expected "${value}".`)
    this.pos++
  }

  /** `;` ya da satırla ayrılmış ifadeler; `ad = ifade` atamadır. */
  program(): { name: string | null; value: Value }[] {
    const results: { name: string | null; value: Value }[] = []
    while (this.pos < this.tokens.length) {
      if (this.isOp(';')) {
        this.pos++
        continue
      }
      const t = this.peek()
      const next = this.tokens[this.pos + 1]
      if (t?.kind === 'id' && next?.kind === 'op' && next.value === '=') {
        if (t.value in CONSTANTS || t.value in FUNCTIONS) throw new ExprError(`"${t.value}" is a built-in name.`)
        this.pos += 2
        const value = this.expression()
        this.vars.set(t.value, value)
        results.push({ name: t.value, value })
      } else {
        results.push({ name: null, value: this.expression() })
      }
      if (this.pos < this.tokens.length && !this.isOp(';')) throw new ExprError('Expected ";" or a new line between statements.')
    }
    return results
  }

  private expression(): Value {
    let left = this.term()
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.tokens[this.pos++] as { value: string }).value
      const right = this.term()
      left = op === '+' ? add(left, right) : sub(left, right)
    }
    return left
  }

  private term(): Value {
    let left = this.unary()
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.tokens[this.pos++] as { value: string }).value
      const right = this.unary()
      if (op === '*') left = mulValues(left, right)
      else if (op === '/') left = binary(left, right, '/', (x, y) => x / y)
      else left = binary(left, right, '%', (x, y) => x % y)
    }
    return left
  }

  private unary(): Value {
    if (this.isOp('-')) {
      this.pos++
      return elementwise(this.unary(), (x) => -x)
    }
    if (this.isOp('+')) {
      this.pos++
      return this.unary()
    }
    return this.power()
  }

  private power(): Value {
    const base = this.postfix()
    if (this.isOp('^')) {
      this.pos++
      // Sağdan birleşir: 2^3^2 = 2^9; -2^2 = -(2^2)
      const exponent = this.unary()
      return binary(base, exponent, '^', (x, y) => x ** y)
    }
    return base
  }

  private postfix(): Value {
    let value = this.primary()
    while (this.isOp('[')) {
      this.pos++
      const index = num(this.expression(), 'index')
      this.expect(']')
      const array = vecAny(value, 'indexing')
      if (!Number.isInteger(index) || index < 0 || index >= array.length) throw new ExprError(`Index ${index} is out of range.`)
      value = array[index]
    }
    return value
  }

  private primary(): Value {
    const t = this.peek()
    if (!t) throw new ExprError('Unexpected end of expression.')
    this.pos++
    if (t.kind === 'num') return t.value
    if (t.kind === 'id') {
      if (this.isOp('(')) {
        const fn = FUNCTIONS[t.value]
        if (!fn) throw new ExprError(`Unknown function "${t.value}".`)
        this.pos++
        const args: Value[] = []
        if (!this.isOp(')')) {
          args.push(this.expression())
          while (this.isOp(',')) {
            this.pos++
            args.push(this.expression())
          }
        }
        this.expect(')')
        return fn.fn(args)
      }
      if (this.vars.has(t.value)) return this.vars.get(t.value)!
      if (t.value in CONSTANTS) return CONSTANTS[t.value]
      throw new ExprError(`Unknown name "${t.value}".`)
    }
    if (t.value === '(') {
      const value = this.expression()
      this.expect(')')
      return value
    }
    if (t.value === '[') {
      const items: number[] = []
      if (!this.isOp(']')) {
        do {
          if (this.isOp(',')) this.pos++
          items.push(num(this.expression(), 'vector component'))
        } while (this.isOp(','))
      }
      this.expect(']')
      return items
    }
    throw new ExprError(`Unexpected "${t.value}".`)
  }
}

export function evaluate(source: string): { name: string | null; value: Value }[] {
  const tokens = tokenize(source)
  if (!tokens.length) throw new ExprError('The expression is empty.')
  const results = new Parser(tokens, new Map()).program()
  for (const { value } of results) {
    const bad = Array.isArray(value) ? value.some((n) => !Number.isFinite(n)) : !Number.isFinite(value)
    if (bad) throw new ExprError('The result is not a finite number (division by zero or out-of-domain input?).')
  }
  return results
}

/** 12 anlamlı basamak; çok küçük kayan nokta artıkları 0 yazılır. */
export function formatValue(value: Value): string {
  const one = (n: number): string => {
    if (Math.abs(n) < 1e-13) return '0'
    const s = Number(n.toPrecision(12)).toString()
    return s
  }
  return Array.isArray(value) ? `[${value.map(one).join(', ')}]` : one(value)
}
