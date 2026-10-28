import fs from 'node:fs'
import path from 'node:path'
import { parseValue, zero } from '../shared/values.ts'
import type { EditKind, Value } from '../shared/values.ts'

export type Opt = { label: string; value: string | number }
export type GdProp = { name: string; kind: EditKind | 'readonly'; def?: Value; options?: Opt[] }

const KIND: Record<string, EditKind> = {
  int: 'int', float: 'float', bool: 'bool', String: 'string', StringName: 'stringname',
  Color: 'color', Vector2: 'vec2', Vector3: 'vec3',
}
const SKIP = new Set(['.godot', 'node_modules', '.git', '.trespass-trash'])

/** Recursive file list that never descends into .godot (huge import cache) or node_modules. */
export function walk(dir: string, ext: string, sub = ''): string[] {
  return fs.readdirSync(path.join(dir, sub), { withFileTypes: true }).flatMap((d) => {
    const rel = sub ? `${sub}/${d.name}` : d.name
    return d.isDirectory() ? (SKIP.has(d.name) ? [] : walk(dir, ext, rel)) : d.name.endsWith(ext) ? [rel] : []
  })
}

const texts = new Map<string, { m: number; text: string }>()
/** readFileSync that only re-reads when mtime changed */
export function readCached(file: string): string {
  const m = fs.statSync(file).mtimeMs, c = texts.get(file)
  if (c?.m === m) return c.text
  const text = fs.readFileSync(file, 'utf8')
  texts.set(file, { m, text })
  return text
}

/** class_name -> absolute .gd path */
export function indexGd(root: string): Map<string, string> {
  const idx = new Map<string, string>()
  for (const f of walk(root, '.gd')) {
    const abs = path.join(root, f)
    const n = /^class_name\s+(\w+)/m.exec(readCached(abs))?.[1]
    if (n) idx.set(n, abs)
  }
  return idx
}

function readGd(file: string) {
  const text = readCached(file)
  const ext = /^extends\s+("[^"]+"|\w+)/m.exec(text)?.[1].replaceAll('"', '')
  const enums = new Map<string, Map<string, number>>()
  for (const m of text.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) {
    const mem = new Map<string, number>()
    let n = 0
    for (const e of m[2].split(',')) {
      const k = /^\s*(\w+)\s*(?:=\s*(-?\d+))?/.exec(e)
      if (!k) continue
      if (k[2]) n = Number(k[2])
      mem.set(k[1], n++)
    }
    enums.set(m[1], mem)
  }
  const props: GdProp[] = []
  for (const line of text.split('\n')) {
    // ponytail: a '#' inside a string default cuts it (default shows as unknown); one @export per line
    const m = /^\s*@export(\w*)(?:\((.*)\))?\s+var\s+(\w+)\s*(?::\s*([\w.]+(?:\[[\w.]+\])?)?)?\s*(?:=\s*(.*?))?\s*(?:#.*)?$/.exec(line)
    if (!m) continue
    const [, ann, args, name, type, defText] = m
    let def: Value | undefined
    if (defText) {
      const en = /^(\w+)\.(\w+)$/.exec(defText)
      const ev = en && enums.get(en[1])?.get(en[2])
      def = ev !== undefined && ev !== null ? { kind: 'int', value: ev } : parseValue(defText)
    }
    let kind: EditKind | 'readonly' =
      type ? KIND[type] ?? (enums.has(type) || type.includes('.') ? 'int' : 'readonly')
      : def && def.kind !== 'raw' && def.kind !== 'extref' ? def.kind : 'readonly'
    if (kind !== 'readonly') {
      if (def?.kind === 'int' && kind === 'float') def = { kind: 'float', value: def.value }
      if (def && def.kind !== kind) def = undefined // not a literal we understand: default unknown
      if (!defText) def = zero(kind)
    } else def = undefined
    let options: Opt[] | undefined
    if (kind !== 'readonly' && ann === '_enum' && args) {
      let n = 0
      options = [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((s) => {
        const [label, v] = s[1].split(':')
        if (kind === 'int') { if (v !== undefined) n = Number(v); return { label, value: n++ } }
        return { label, value: label }
      })
    } else if (type && enums.has(type)) {
      options = [...enums.get(type)!].map(([label, value]) => ({ label, value }))
    }
    props.push({ name, kind, def, options })
  }
  return { ext, props }
}

/** Exported props for a class, parent chain first. Falls back to scriptPath if class_name isn't indexed. */
export function exportsOf(cls: string, idx: Map<string, string>, projectRoot: string, scriptPath?: string): GdProp[] {
  const chain: GdProp[][] = []
  const seen = new Set<string>()
  let file: string | undefined = idx.get(cls) ?? (scriptPath?.startsWith('res://') ? path.join(projectRoot, scriptPath.slice(6)) : undefined)
  while (file && !seen.has(file) && fs.existsSync(file)) {
    seen.add(file)
    const g = readGd(file)
    chain.unshift(g.props)
    file = !g.ext ? undefined : g.ext.startsWith('res://') ? path.join(projectRoot, g.ext.slice(6)) : idx.get(g.ext)
  }
  return [...new Map(chain.flat().map((p) => [p.name, p])).values()]
}
