import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { parseTres, applyEdits, lineDiff } from './server/parse-tres.ts'
import { exportsOf, indexGd, readCached, walk } from './server/parse-gd.ts'
import type { GdProp } from './server/parse-gd.ts'
import { serveStatic } from './server/static.ts'
import { formatValue, parseValue } from './shared/values.ts'

const dir = path.resolve(process.argv[2] ?? '.')
if (!fs.existsSync(dir)) { console.error(`no such folder: ${dir}`); process.exit(1) }
const port = Number(process.env.PORT ?? 4173)

// project root = nearest ancestor with project.godot (res:// resolves against it)
let projectRoot = dir
for (let d = dir; ; d = path.dirname(d)) {
  if (fs.existsSync(path.join(d, 'project.godot'))) { projectRoot = d; break }
  if (path.dirname(d) === d) break
}

const NONE = '(none)'
const IMG: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
const abs = (file: string) => {
  const p = path.resolve(dir, file)
  if (!p.startsWith(dir + path.sep) || !p.endsWith('.tres')) throw new Error(`bad path: ${file}`)
  return p
}
const parsed = new Map<string, { text: string; t: ReturnType<typeof parseTres> }>()
const loadAll = () => walk(dir, '.tres').map((file) => {
  const p = path.join(dir, file), text = readCached(p)
  let c = parsed.get(file)
  if (c?.text !== text) { c = { text, t: parseTres(text) }; parsed.set(file, c) }
  return { file, text, mtime: fs.statSync(p).mtimeMs, t: c.t }
})

const hasRes = (p: string) => fs.existsSync(path.join(projectRoot, p.replace(/^res:\/\//, '')))
/** res:// paths used by a file (ext_resources + string values) that don't exist on disk */
const missingRefs = (text: string) =>
  [...new Set(text.match(/"res:\/\/[^"]*"/g)?.map((s) => s.slice(1, -1)))].filter((p) => !hasRes(p))

function classes() {
  const n = new Map<string, number>()
  for (const f of loadAll()) { const c = f.t.header.script_class ?? NONE; n.set(c, (n.get(c) ?? 0) + 1) }
  return [...n].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name))
}

// res:// path of the first file's script, used when class_name isn't indexed
const scriptPath = (files: { t: ReturnType<typeof parseTres> }[]) => {
  for (const { t } of files) {
    const v = parseValue(t.props.get('script')?.raw ?? '')
    if (v.kind === 'extref' && t.ext[v.id]) return t.ext[v.id].path
  }
}

function classData(name: string) {
  const files = loadAll().filter((f) => (f.t.header.script_class ?? NONE) === name)
  const schema: GdProp[] = name === NONE ? [] : exportsOf(name, indexGd(projectRoot), projectRoot, scriptPath(files))
  const known = new Set(schema.map((p) => p.name))
  const extras = new Map<string, GdProp>() // props in files but not declared in the script
  for (const f of files) for (const [k, p] of f.t.props) {
    if (k === 'script' || known.has(k) || extras.has(k)) continue
    const kind = parseValue(p.raw).kind
    extras.set(k, { name: k, kind: kind === 'raw' || kind === 'extref' ? 'readonly' : kind })
  }
  const columns = [...schema, ...extras.values()].map((p) => ({
    name: p.name, kind: p.kind, options: p.options, def: p.def && formatValue(p.def),
  }))
  const rows = files.map((f) => ({
    file: f.file, mtime: f.mtime,
    props: Object.fromEntries([...f.t.props].map(([k, p]) => [k, p.raw])),
    ext: Object.fromEntries(Object.entries(f.t.ext).map(([id, e]) => [id, e.path])),
    missing: missingRefs(f.text),
  }))
  return { columns, rows }
}

type Edits = Record<string, Record<string, string | null>>
function save(body: { edits: Edits; mtimes: Record<string, number>; dry?: boolean }) {
  return Object.entries(body.edits).map(([file, edits]) => {
    try {
      for (const [k, v] of Object.entries(edits))
        if (!/^[\w/.:-]+$/.test(k) || (v !== null && /[\r\n]/.test(v) && !/^"/.test(v))) throw new Error(`refusing property ${k}`)
      const p = abs(file)
      const text = fs.readFileSync(p, 'utf8')
      if (fs.statSync(p).mtimeMs !== body.mtimes[file]) return { file, ok: false, error: 'changed on disk since loaded', diff: [] }
      const out = applyEdits(parseTres(text), edits)
      if (!body.dry && out !== text) {
        const tmp = `${p}.tmp-${process.pid}`
        fs.writeFileSync(tmp, out)
        fs.renameSync(tmp, p)
      }
      return { file, ok: true, diff: lineDiff(text, out) }
    } catch (e) {
      return { file, ok: false, error: (e as Error).message, diff: [] }
    }
  })
}

function duplicate({ file, name, blank }: { file: string; name: string; blank?: boolean }) {
  const src = abs(file)
  const base = name.endsWith('.tres') ? name : name + '.tres'
  if (path.basename(base) !== base) throw new Error('name must be a plain file name')
  let text = fs.readFileSync(src, 'utf8').replace(/^(\[gd_resource[^\]\n]*?)\s+uid="[^"]*"/, '$1') // Godot assigns a fresh uid
  if (blank) { // every property but the script link goes back to its script default
    const t = parseTres(text)
    text = applyEdits(t, Object.fromEntries([...t.props.keys()].filter((k) => k !== 'script').map((k) => [k, null])))
  }
  fs.writeFileSync(path.join(path.dirname(src), base), text, { flag: 'wx' })
}

function trash({ file }: { file: string }) {
  const src = abs(file)
  const dest = path.join(dir, '.trespass-trash', file.replaceAll('/', '__'))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(src, `${dest}.${Date.now()}`) // restore by moving back and dropping the timestamp
}

/** Literal find/replace over property values in every .tres; goes through save() so it gets the same diff + stale check. */
function replaceAll({ find, repl, dry }: { find: string; repl: string; dry?: boolean }) {
  if (!find) throw new Error('nothing to find')
  const edits: Edits = {}, mtimes: Record<string, number> = {}
  for (const { f, k, p } of matches(find)) {
    if (k === 'script') continue
    ;(edits[f.file] ??= {})[k] = p.raw.replaceAll(find, repl)
    mtimes[f.file] = f.mtime
  }
  return save({ edits, mtimes, dry })
}

function* matches(q: string, ci = false) {
  const n = ci ? q.toLowerCase() : q
  for (const f of loadAll()) for (const [k, p] of f.t.props) if ((ci ? p.raw.toLowerCase() : p.raw).includes(n)) yield { f, k, p }
}
const find = (q: string) => [...matches(q, true)].map(({ f, k, p }) => ({ file: f.file, prop: k, raw: p.raw.slice(0, 120) }))

const clients = new Set<http.ServerResponse>()
let timer: NodeJS.Timeout | undefined
fs.watch(dir, { recursive: true }, (_, f) => {
  if (!f?.endsWith('.tres')) return
  clearTimeout(timer)
  timer = setTimeout(() => clients.forEach((c) => c.write('data: changed\n\n')), 150)
})

const readBody = async (req: http.IncomingMessage) => JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || '{}')

http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://x')
  const json = (o: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  try {
    if (serveStatic(u.pathname, res)) return
    if (u.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write('\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
    } else if (u.pathname === '/api/res') { // image preview: res:// path -> file, images only, inside the project
      const f = path.resolve(projectRoot, (u.searchParams.get('path') ?? '').replace(/^res:\/\//, ''))
      const type = IMG[path.extname(f).toLowerCase()]
      if (!type || !f.startsWith(projectRoot + path.sep) || !fs.existsSync(f)) return json({ error: 'not an image' }, 404)
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
      res.end(fs.readFileSync(f))
    } else if (u.pathname === '/api/classes') json({ dir, classes: classes() })
    else if (u.pathname === '/api/class') json(classData(u.searchParams.get('name') ?? ''))
    else if (u.pathname === '/api/save' && req.method === 'POST') json(save(await readBody(req)))
    else if (u.pathname === '/api/dup' && req.method === 'POST') { duplicate(await readBody(req)); json({ ok: true }) }
    else if (u.pathname === '/api/del' && req.method === 'POST') { trash(await readBody(req)); json({ ok: true }) }
    else if (u.pathname === '/api/replace' && req.method === 'POST') json(replaceAll(await readBody(req)))
    else if (u.pathname === '/api/find') json(find(u.searchParams.get('q') ?? ''))
    else json({ error: 'not found' }, 404)
  } catch (e) {
    json({ error: (e as Error).message }, 500)
  }
}).listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`
  console.log(`trespass: ${dir}\n  ${url}`)
  if (!process.env.NO_OPEN) exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} ${url}`)
})
