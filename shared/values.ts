// Value model shared by server (parse/format) and browser (cells/display).
export type Value =
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'stringname'; value: string }
  | { kind: 'color'; c: [number, number, number, number] }
  | { kind: 'vec2'; v: [number, number] }
  | { kind: 'vec3'; v: [number, number, number] }
  | { kind: 'extref'; id: string }
  | { kind: 'raw'; text: string }

export type EditKind = Exclude<Value['kind'], 'extref' | 'raw'>

const STR = '"((?:[^"\\\\]|\\\\.)*)"'
const NUM = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i
const quote = (s: string) =>
  '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"'
const unquote = (s: string) => s.replace(/\\(.)/gs, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
const nums = (s: string) => s.split(',').map((x) => (x.trim() === '' ? NaN : Number(x)))

export function parseValue(text: string): Value {
  const s = text.trim()
  let m: RegExpExecArray | null
  if (s === 'true' || s === 'false') return { kind: 'bool', value: s === 'true' }
  if (/^-?\d+$/.test(s)) return { kind: 'int', value: Number(s) }
  if (NUM.test(s)) return { kind: 'float', value: Number(s) }
  if ((m = new RegExp(`^${STR}$`, 's').exec(s))) return { kind: 'string', value: unquote(m[1]) }
  if ((m = new RegExp(`^&${STR}$`, 's').exec(s))) return { kind: 'stringname', value: unquote(m[1]) }
  if ((m = /^ExtResource\(\s*"([^"]*)"\s*\)$/.exec(s))) return { kind: 'extref', id: m[1] }
  if ((m = /^(Color|Vector2|Vector3)\(([^()]*)\)$/.exec(s))) {
    const n = nums(m[2])
    if (n.every(Number.isFinite)) {
      if (m[1] === 'Color' && n.length === 4) return { kind: 'color', c: n as [number, number, number, number] }
      if (m[1] === 'Vector2' && n.length === 2) return { kind: 'vec2', v: n as [number, number] }
      if (m[1] === 'Vector3' && n.length === 3) return { kind: 'vec3', v: n as [number, number, number] }
    }
  }
  return { kind: 'raw', text: s }
}

export function formatValue(v: Value): string {
  switch (v.kind) {
    case 'int': return String(v.value)
    case 'float': return Number.isInteger(v.value) ? v.value.toFixed(1) : String(v.value)
    case 'bool': return String(v.value)
    case 'string': return quote(v.value)
    case 'stringname': return '&' + quote(v.value)
    case 'color': return `Color(${v.c.join(', ')})`
    case 'vec2': return `Vector2(${v.v.join(', ')})`
    case 'vec3': return `Vector3(${v.v.join(', ')})`
    case 'extref': return `ExtResource("${v.id}")`
    case 'raw': return v.text
  }
}

/** What Godot assumes when a property is missing and the script has no explicit default. */
export function zero(kind: EditKind): Value {
  switch (kind) {
    case 'int': return { kind, value: 0 }
    case 'float': return { kind, value: 0 }
    case 'bool': return { kind, value: false }
    case 'string': return { kind, value: '' }
    case 'stringname': return { kind, value: '' }
    case 'color': return { kind, c: [0, 0, 0, 1] }
    case 'vec2': return { kind, v: [0, 0] }
    case 'vec3': return { kind, v: [0, 0, 0] }
  }
}

const hx = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')

/** Grid-cell primitive for an editable value. */
export function toCell(v: Value): string | number | boolean {
  switch (v.kind) {
    case 'int': case 'float': case 'bool': case 'string': case 'stringname': return v.value
    case 'color': return '#' + v.c.slice(0, 3).map(hx).join('') + (v.c[3] === 1 ? '' : hx(v.c[3]))
    case 'vec2': case 'vec3': return v.v.join(', ')
    case 'extref': case 'raw': return formatValue(v)
  }
}

/** Short read-only label, e.g. goblin.png for an ExtResource. */
export function summary(v: Value, ext: Record<string, string>): string {
  if (v.kind === 'extref') return (ext[v.id] ?? v.id).split('/').pop()!
  const t = formatValue(v).replace(/\s+/g, ' ')
  return t.length > 60 ? t.slice(0, 57) + '...' : t
}

/** Parse user/pasted/CSV text into a typed value; throws a readable Error. */
export function fromCell(kind: EditKind, x: unknown): Value {
  const s = String(x).trim()
  switch (kind) {
    case 'int': {
      const n = Number(s)
      if (s === '' || !Number.isInteger(n)) throw new Error(`"${s}" is not an integer`)
      return { kind, value: n }
    }
    case 'float': {
      const n = Number(s)
      if (s === '' || !Number.isFinite(n)) throw new Error(`"${s}" is not a number`)
      return { kind, value: n }
    }
    case 'bool': {
      if (/^(true|1|yes|y)$/i.test(s)) return { kind, value: true }
      if (/^(false|0|no|n)$/i.test(s)) return { kind, value: false }
      throw new Error(`"${s}" is not a bool`)
    }
    case 'string': case 'stringname': return { kind, value: String(x) }
    case 'color': {
      const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s)
      if (!m) throw new Error(`"${s}" is not a #rrggbb[aa] color`)
      const c = [0, 2, 4].map((i) => +(parseInt(m[1].slice(i, i + 2), 16) / 255).toFixed(4))
      return { kind, c: [c[0], c[1], c[2], m[2] ? +(parseInt(m[2], 16) / 255).toFixed(4) : 1] }
    }
    case 'vec2': case 'vec3': {
      const n = s.split(/[,\s]+/).map(Number)
      const want = kind === 'vec2' ? 2 : 3
      if (n.length !== want || !n.every(Number.isFinite)) throw new Error(`"${s}" needs ${want} numbers`)
      return (kind === 'vec2' ? { kind, v: [n[0], n[1]] } : { kind, v: [n[0], n[1], n[2]] }) as Value
    }
  }
}
