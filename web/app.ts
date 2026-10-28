import { parseValue, formatValue, toCell, fromCell, summary } from '../shared/values.ts'
import type { Value, EditKind } from '../shared/values.ts'
import { evalFormula } from '../shared/formula.ts'

declare const Tabulator: any

type Col = { name: string; kind: EditKind | 'readonly'; options?: { label: string; value: string | number }[]; def?: string }
type Row = { file: string; mtime: number; props: Record<string, string>; ext: Record<string, string>; missing: string[] }
type St = { row: Row; base: Map<string, Value>; pending: Map<string, Value | null>; stale: boolean }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const rows = new Map<string, St>()
const defs = new Map<string, Value>()
let cols: Col[] = []
let sig = ''
let table: any

const api = async (url: string, body?: unknown) => {
  const r = await fetch(url, body ? { method: 'POST', body: JSON.stringify(body) } : undefined)
  const j = await r.json()
  if (j.error) throw new Error(j.error)
  return j
}
let toastT: number
const toast = (msg: string) => {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block'
  clearTimeout(toastT); toastT = window.setTimeout(() => (t.style.display = 'none'), 4000)
}
const same = (a?: Value | null, b?: Value | null) => !!a && !!b && formatValue(a) === formatValue(b)
const field = (i: number) => 'c' + i
const colOf = (f: string) => (/^c\d+$/.test(f) ? cols[+f.slice(1)] : undefined)

// ---- problems: missing res:// files, duplicate id/name ----
let dupes = new Map<string, string>() // file -> message
function findProblems() {
  dupes = new Map()
  for (const c of cols.filter((c) => /^(id|name)$/i.test(c.name))) {
    const val = (st: St) => { const v = effective(st, c); return v ? String(toCell(v)) : '' }
    for (const [v, g] of Map.groupBy(rows, ([, st]) => val(st))) if (v && g.length > 1) g.forEach(([f]) => dupes.set(f, `duplicate ${c.name} "${v}"`))
  }
}
const problemsOf = (f: string) => [...(rows.get(f)?.row.missing.map((m) => `missing ${m}`) ?? []), ...(dupes.has(f) ? [dupes.get(f)!] : [])]

// ---- undo / redo (snapshots of the pending edits) ----
type Snap = Map<string, Map<string, Value | null>>
const snap = (): Snap => new Map([...rows].filter(([, s]) => s.pending.size).map(([f, s]) => [f, new Map(s.pending)]))
const undo: Snap[] = [], redo: Snap[] = []
function restore(s: Snap) {
  for (const [f, st] of rows) st.pending = new Map(s.get(f) ?? [])
  refresh(rows.keys()); status()
}
function step(from: Snap[], to: Snap[]) {
  const s = from.pop()
  if (!s) return toast('nothing to undo')
  to.push(snap()); restore(s)
}

// ---- state -> cells ----
const effective = (st: St, c: Col): Value | undefined =>
  st.pending.has(c.name) ? st.pending.get(c.name) ?? defs.get(c.name) : st.base.get(c.name) ?? defs.get(c.name)
const isDefault = (st: St, c: Col) => (st.pending.has(c.name) ? st.pending.get(c.name) === null : !st.base.has(c.name))

function cellOf(st: St, c: Col) {
  const v = effective(st, c)
  if (!v) return ''
  return c.kind === 'readonly' ? summary(v, st.row.ext) : toCell(v)
}
const rowData = (st: St) => ({ _file: st.row.file, ...Object.fromEntries(cols.map((c, i) => [field(i), cellOf(st, c)])) })

function refresh(files: Iterable<string>) {
  for (const f of files) {
    const r = table.getRow(f), st = rows.get(f)
    if (r && st) { r.update(rowData(st)); r.reformat() }
  }
}

/** Stage a typed value; no-ops and reverts-to-default are normalised so Save only writes real changes. */
function setCell(file: string, c: Col, v: Value) {
  const st = rows.get(file)!
  const disk = st.base.get(c.name)
  const want = same(v, defs.get(c.name)) ? null : v // null = drop the line (back to script default)
  if ((want === null && !disk) || (want && same(want, disk))) st.pending.delete(c.name)
  else st.pending.set(c.name, want)
}

function stage(file: string, c: Col, x: unknown) {
  if (c.kind === 'readonly') throw new Error(`${c.name} is read-only`)
  if (c.options) {
    const s = String(x).trim()
    const o = c.options.find((o) => String(o.label) === s || String(o.value) === s)
    if (!o) throw new Error(`"${s}" is not one of ${c.options.map((o) => o.label).join(', ')}`)
    x = o.value
  }
  setCell(file, c, fromCell(c.kind, x))
}

/** Run fn over the targets, collect errors, redraw touched rows once. */
function batch(targets: { file: string; c: Col; x: unknown }[]) {
  undo.push(snap()); redo.length = 0; if (undo.length > 100) undo.shift()
  const touched = new Set<string>(), errs: string[] = []
  for (const { file, c, x } of targets) {
    try { stage(file, c, x); touched.add(file) } catch (e) { errs.push((e as Error).message) }
  }
  refresh(touched)
  status()
  if (errs.length) toast(`${errs.length} rejected: ${errs[0]}`)
}

// ---- grid ----
const cellRef = (cell: any) => ({ file: cell.getRow().getData()._file as string, c: colOf(cell.getColumn().getField()) })
const selected = (): any[][] => table.getRanges().flatMap((r: any) => r.getStructuredCells())

/** res:// path behind a read-only ExtResource cell, if it is a browser-displayable image */
function imageOf(st: St, c: Col) {
  const v = effective(st, c)
  const p = v?.kind === 'extref' ? st.row.ext[v.id] : undefined
  return p ? '/api/res?path=' + encodeURIComponent(p) : undefined
}

function formatter(c: Col) {
  return (cell: any) => {
    const file = cell.getRow().getData()._file, st = rows.get(file)!, el = cell.getElement(), v = cell.getValue()
    el.classList.toggle('pending', st.pending.has(c.name))
    el.classList.toggle('dflt', isDefault(st, c))
    el.classList.toggle('ro', c.kind === 'readonly')
    if (c.kind === 'bool') {
      const i = document.createElement('input')
      i.type = 'checkbox'; i.checked = !!v
      i.onchange = () => batch([{ file, c, x: i.checked }])
      return i
    }
    const s = document.createElement('span')
    const src = c.kind === 'readonly' ? imageOf(st, c) : undefined
    if (src) { const im = new Image(); im.onerror = () => im.remove(); im.src = src; im.className = 'thumb'; s.append(im) }
    if (c.kind === 'color' && v) { const w = document.createElement('i'); w.className = 'sw'; w.style.background = String(v); s.append(w) }
    s.append(String(c.options?.find((o) => o.value === v)?.label ?? v))
    return s
  }
}

function columnDefs() {
  return [
    { title: 'file', field: '_file', frozen: true, sorter: 'string', formatter: (cell: any) => {
      const f = cell.getValue() as string, p = problemsOf(f), s = document.createElement('span')
      s.textContent = (p.length ? '⚠ ' : '') + f; s.title = p.join('\n'); s.className = p.length ? 'err' : ''
      return s
    } },
    ...cols.map((c, i) => ({
      title: c.name, field: field(i), headerMenu: [{ label: 'Hide column', action: (_: unknown, col: any) => { col.hide(); saveView() } }], formatter: formatter(c),
      sorter: c.kind === 'int' || c.kind === 'float' ? 'number' : c.kind === 'bool' ? 'boolean' : 'string',
      editor: c.kind === 'readonly' || c.kind === 'bool' ? false : c.options ? 'list' : 'input',
      editorParams: c.options ? { values: c.options.map((o) => ({ label: String(o.label), value: o.value })) } : undefined,
      cellEdited: (cell: any) => { const r = cellRef(cell); batch([{ file: r.file, c: c, x: cell.getValue() }]) },
      cellDblClick: c.kind === 'readonly' ? (_: unknown, cell: any) => { const st = rows.get(cell.getRow().getData()._file)!; popup(`${c.name} (read-only)\n\n${st.row.props[c.name] ?? '(script default)'}`, false, imageOf(st, c)) } : undefined,
    })),
  ]
}

// ---- load / live reload ----
async function load(cls = $<HTMLSelectElement>('cls').value) {
  const d = await api('/api/class?name=' + encodeURIComponent(cls))
  const next = JSON.stringify(d.columns)
  if (next !== sig) { // different class / schema: rebuild everything
    sig = next; cols = d.columns; rows.clear(); undo.length = redo.length = 0
    defs.clear()
    cols.forEach((c) => c.def !== undefined && defs.set(c.name, parseValue(c.def)))
    table.setColumns(columnDefs())
  }
  const fresh = new Set<string>(d.rows.map((r: Row) => r.file))
  for (const f of [...rows.keys()]) if (!fresh.has(f)) rows.delete(f)
  for (const r of d.rows as Row[]) {
    const old = rows.get(r.file)
    if (old?.pending.size) { old.stale = old.row.mtime !== r.mtime; continue } // unsaved edits: flag, never overwrite
    rows.set(r.file, { row: r, base: new Map(Object.entries(r.props).map(([k, v]) => [k, parseValue(v)])), pending: new Map(), stale: false })
  }
  findProblems()
  await table.setData([...rows.values()].map(rowData))
  restoreView()
  loadFolders()
  status()
}

function status() {
  const n = [...rows.values()].filter((s) => s.pending.size)
  const stale = n.filter((s) => s.stale).length, bad = [...rows.values()].some((s) => s.row.missing.length)
  $('status').textContent = `${rows.size} files · ${n.length} with unsaved edits${stale ? ` · ${stale} CHANGED ON DISK (save will refuse, Discard to reload)` : ''}${dupes.size || bad ? ` · ⚠ ${new Set([...dupes.keys(), ...[...rows.keys()].filter((f) => rows.get(f)!.row.missing.length)]).size} file(s) with problems (hover the file name)` : ''}`
  table.getRows().forEach((r: any) => r.reformat())
}

async function loadClasses() {
  const d = await api('/api/classes')
  const sel = $<HTMLSelectElement>('cls'), prev = sel.value
  sel.replaceChildren(...d.classes.map((c: any) => new Option(`${c.name} (${c.count})`, c.name)))
  if (d.classes.some((c: any) => c.name === prev)) sel.value = prev
}

// ---- dialog ----
const dlg = $<HTMLDialogElement>('dlg')
function popup(text: string, ok = false, img?: string): Promise<boolean> {
  $('dbody').textContent = text
  const di = $<HTMLImageElement>('dimg')
  di.style.display = img ? '' : 'none'
  di.onerror = () => (di.style.display = 'none')
  if (img) di.src = img
  $('ok').style.display = ok ? '' : 'none'
  dlg.returnValue = 'cancel'
  dlg.showModal()
  return new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true }))
}

// ---- save / discard ----
const collect = () => {
  const edits: Record<string, Record<string, string | null>> = {}, mtimes: Record<string, number> = {}
  for (const [f, st] of rows) if (st.pending.size) {
    edits[f] = Object.fromEntries([...st.pending].map(([k, v]) => [k, v === null ? null : formatValue(v)]))
    mtimes[f] = st.row.mtime
  }
  return { edits, mtimes }
}

const diffText = (res: any[]) => res.map((r) => `${r.file}${r.ok ? '' : '   !! ' + r.error}\n` + r.diff.map((l: any) => `  ${l.type} ${String(l.n).padStart(4)}  ${l.text}`).join('\n')).join('\n\n')

$('save').onclick = async () => {
  const body = collect()
  if (!Object.keys(body.edits).length) return toast('nothing to save')
  const dry = await api('/api/save', { ...body, dry: true })
  if (!(await popup(diffText(dry), true))) return
  const res = await api('/api/save', body)
  const bad = res.filter((r: any) => !r.ok)
  for (const r of res) if (r.ok) rows.get(r.file)!.pending.clear()
  for (const r of bad) rows.get(r.file)!.stale = true
  undo.length = redo.length = 0
  await load()
  toast(bad.length ? `${bad.length} file(s) refused: ${bad[0].error}` : `wrote ${res.length} file(s)`)
}

$('discard').onclick = async () => { for (const st of rows.values()) st.pending.clear(); undo.length = redo.length = 0; await load() }

// ---- bulk tools ----
const first = (): { file: string; c: Col; cell: any }[] =>
  selected().flat().flatMap((cell) => { const r = cellRef(cell); return r.c ? [{ file: r.file, c: r.c, cell }] : [] })

$('fill').onclick = () => {
  const targets: { file: string; c: Col; x: unknown }[] = []
  for (const grid of table.getRanges().map((r: any) => r.getStructuredCells())) {
    for (let j = 0; j < grid[0].length; j++) {
      const top = cellRef(grid[0][j])
      const v = top.c && effective(rows.get(top.file)!, top.c)
      if (!top.c || !v) continue
      for (const row of grid.slice(1)) targets.push({ file: cellRef(row[j]).file, c: top.c, x: top.c.options ? (v as any).value : toCell(v) })
    }
  }
  if (!targets.length) return toast('select a range of 2+ rows first')
  batch(targets)
}

$('apply').onclick = () => {
  const expr = $<HTMLInputElement>('formula').value.trim()
  const targets: { file: string; c: Col; x: unknown }[] = []
  try {
    for (const { file, c } of first()) {
      if (c.kind !== 'int' && c.kind !== 'float') continue
      const v = effective(rows.get(file)!, c)
      if (v?.kind !== 'int' && v?.kind !== 'float') continue
      const n = evalFormula(expr, v.value)
      targets.push({ file, c, x: c.kind === 'int' ? Math.round(n) : n })
    }
  } catch (e) { return toast((e as Error).message) }
  if (!targets.length) return toast('select number cells first')
  batch(targets)
}

document.addEventListener('paste', (e) => {
  if ((e.target as HTMLElement).closest('input,textarea') || !table.getRanges().length) return
  const text = e.clipboardData?.getData('text') ?? ''
  const block = text.replace(/\r?\n$/, '').split(/\r?\n/).map((l) => l.split('\t'))
  const cells = first()
  if (!cells.length) return
  e.preventDefault()
  const targets: { file: string; c: Col; x: unknown }[] = []
  if (block.length === 1 && block[0].length === 1) cells.forEach(({ file, c }) => targets.push({ file, c, x: block[0][0] })) // 1 value fills the selection
  else {
    const vis: string[] = table.getRows('active').map((r: any) => r.getData()._file)
    const fields: string[] = table.getColumns().map((c: any) => c.getField()).filter((f: string) => colOf(f))
    const f0 = cells[0].cell.getColumn().getField()
    const r0 = vis.indexOf(cells[0].file), c0 = fields.indexOf(f0)
    block.forEach((line, i) => line.forEach((x, j) => {
      const file = vis[r0 + i], c = colOf(fields[c0 + j])
      if (file && c) targets.push({ file, c, x })
    }))
  }
  batch(targets)
})

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || (e.target as HTMLElement).closest('input,textarea,select,dialog')) return
  e.preventDefault()
  e.shiftKey ? step(redo, undo) : step(undo, redo)
})

// type-to-edit / Enter-to-edit on the selected cell
document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input,textarea,select,dialog') || e.metaKey || e.ctrlKey) return
  const cells = first()
  if (cells.length < 1 || cells[0].c?.kind === 'readonly' || cells[0].c?.kind === 'bool') return
  if (e.key.length === 1 || e.key === 'Enter' || e.key === 'F2') {
    cells[0].cell.edit?.()
    const i = document.querySelector<HTMLInputElement>('.tabulator-editing input')
    if (i && e.key.length === 1) { i.value = ''; } // the keystroke lands in the freshly focused editor
  }
})

// filter: `col op value` (== != >= <= > < ~) or plain text matched against every cell; combined with the folder picker
let folder = '', textFilter: (d: any) => boolean = () => true
const applyFilter = () => table.setFilter((d: any) => (!folder || d._file.startsWith(folder + '/')) && textFilter(d))

$<HTMLInputElement>('filter').oninput = (e) => {
  const q = (e.target as HTMLInputElement).value.trim()
  const m = /^(\w+)\s*(==|!=|>=|<=|>|<|~)\s*(.+)$/.exec(q)
  const i = m ? cols.findIndex((c) => c.name === m[1]) : -1
  if (m && i >= 0) {
    const [, , op, rhs] = m, f = field(i)
    textFilter = (d) => {
      const a = d[f], b = typeof a === 'number' ? Number(rhs) : rhs.replace(/^"|"$/g, '')
      const A = typeof a === 'boolean' ? String(a) : a
      return op === '==' ? A == b : op === '!=' ? A != b : op === '>=' ? A >= b : op === '<=' ? A <= b : op === '>' ? A > b : op === '<' ? A < b : String(A).toLowerCase().includes(String(b).toLowerCase())
    }
  } else textFilter = q ? (d) => Object.values(d).some((v) => String(v).toLowerCase().includes(q.toLowerCase())) : () => true
  applyFilter()
  saveView()
}

$<HTMLSelectElement>('folder').onchange = (e) => { folder = (e.target as HTMLSelectElement).value; applyFilter() }

function loadFolders() {
  const set = new Set<string>()
  for (const f of rows.keys()) { const parts = f.split('/').slice(0, -1); parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join('/'))) }
  const sel = $<HTMLSelectElement>('folder')
  if (!set.has(folder)) folder = ''
  sel.replaceChildren(new Option('all folders', ''), ...[...set].sort().map((d) => new Option(d + '/', d)))
  sel.value = folder
  sel.style.display = set.size ? '' : 'none'
  applyFilter()
}

// ---- CSV ----
const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
function parseCSV(s: string): string[][] {
  const out: string[][] = []
  let row: string[] = [], f = '', q = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++ } else q = false } else f += ch }
    else if (ch === '"') q = true
    else if (ch === ',') { row.push(f); f = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(f); f = ''; out.push(row); row = [] }
    else f += ch
  }
  if (f || row.length) { row.push(f); out.push(row) }
  return out
}

$('export').onclick = () => {
  const edit = cols.filter((c) => c.kind !== 'readonly')
  const lines = [['file', ...edit.map((c) => c.name)]]
  for (const r of table.getRows('active')) {
    const st = rows.get(r.getData()._file)!
    lines.push([st.row.file, ...edit.map((c) => { const v = effective(st, c); const x = v ? toCell(v) : ''; return String(c.options?.find((o) => o.value === x)?.label ?? x) })])
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([lines.map((l) => l.map(csvCell).join(',')).join('\n') + '\n'], { type: 'text/csv' }))
  a.download = `${$<HTMLSelectElement>('cls').value}.csv`
  a.click()
}

$('import').onclick = () => $('file').click()
$<HTMLInputElement>('file').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  const [head, ...recs] = parseCSV(await f.text())
  const targets: { file: string; c: Col; x: unknown }[] = []
  let miss = 0
  for (const rec of recs) {
    if (!rows.has(rec[0])) { miss++; continue }
    head.forEach((h, j) => {
      const c = cols.find((c) => c.name === h)
      if (c && c.kind !== 'readonly' && j > 0 && (rec[j] !== '' || c.kind === 'string')) targets.push({ file: rec[0], c, x: rec[j] ?? '' })
    })
  }
  batch(targets)
  toast(`staged ${targets.length} cells${miss ? `, ${miss} unknown file(s) skipped` : ''}`)
  ;(e.target as HTMLInputElement).value = ''
}

// ---- duplicate ----
$('dup').onclick = async () => {
  const c = first()[0]
  if (!c) return toast('select a row first')
  const name = prompt('New file name (same folder)', c.file.split('/').pop()!.replace('.tres', '_copy.tres'))
  if (!name) return
  try { await api('/api/dup', { file: c.file, name }); await load(); toast(`created ${name}`) } catch (e) { toast((e as Error).message) }
}

// ---- new (blank) / delete ----
$('new').onclick = async () => {
  const f = first()[0]?.file ?? [...rows.keys()][0]
  if (!f) return toast('no file to base a new one on')
  const name = prompt('New file name (same folder, all properties at script defaults)', f.split('/').pop()!.replace('.tres', '_new.tres'))
  if (!name) return
  try { await api('/api/dup', { file: f, name, blank: true }); await load(); toast(`created ${name}`) } catch (e) { toast((e as Error).message) }
}

$('del').onclick = async () => {
  const files = [...new Set(first().map((c) => c.file))]
  if (!files.length) return toast('select a row first')
  if (!(await popup(`Move to .trespass-trash/ (restorable):\n\n${files.join('\n')}`, true))) return
  try { for (const file of files) await api('/api/del', { file }); await loadClasses(); await load(); toast(`trashed ${files.length} file(s)`) } catch (e) { toast((e as Error).message) }
}

// ---- find / replace across all classes ----
$('find').onclick = async () => {
  const q = prompt('Find in every property value of every .tres'); if (!q) return
  const hits = await api('/api/find?q=' + encodeURIComponent(q))
  const repl = hits.length ? prompt(`${hits.length} match(es). Replace "${q}" with (blank = just list them, Cancel = close):`) : null
  if (repl === null || repl === '') return void popup(hits.map((h: any) => `${h.file}  ${h.prop} = ${h.raw}`).join('\n') || 'no matches')
  const dry = await api('/api/replace', { find: q, repl, dry: true })
  if (!(await popup(diffText(dry), true))) return
  const res = await api('/api/replace', { find: q, repl })
  await loadClasses(); await load()
  toast(`wrote ${res.filter((r: any) => r.ok).length} file(s)`)
}

// ---- per-class view state: filter + hidden columns ----
$('showcols').onclick = () => { table.getColumns().forEach((c: any) => c.show()); saveView() }
const viewKey = () => 'trespass:' + $<HTMLSelectElement>('cls').value
function saveView() {
  try {
    localStorage[viewKey()] = JSON.stringify({
      filter: $<HTMLInputElement>('filter').value,
      hidden: table.getColumns().filter((c: any) => !c.isVisible()).map((c: any) => c.getField()),
    })
  } catch {}
}
function restoreView() {
  let v: { filter?: string; hidden?: string[] } = {}
  try { v = JSON.parse(localStorage[viewKey()] ?? '{}') } catch {}
  const hid = new Set(v.hidden ?? [])
  table.getColumns().forEach((c: any) => (hid.has(c.getField()) ? c.hide() : c.show()))
  const f = $<HTMLInputElement>('filter')
  if (f.value !== (v.filter ?? '')) { f.value = v.filter ?? ''; f.dispatchEvent(new Event('input')) }
}

// ---- boot ----
table = new Tabulator('#grid', {
  data: [], index: '_file', layout: 'fitDataFill', height: '100%',
  selectableRange: true, selectableRangeColumns: true, selectableRangeRows: true,
  clipboard: 'copy', clipboardCopyRowRange: 'range', // paste is ours (typed + validated)
  columns: [],
  rowFormatter: (row: any) => row.getElement().classList.toggle('stale', !!rows.get(row.getData()._file)?.stale),
})
await new Promise((r) => table.on('tableBuilt', r))
await loadClasses()
$('cls').onchange = () => load()
let t: number
new EventSource('/events').onmessage = () => { clearTimeout(t); t = window.setTimeout(async () => { await loadClasses(); await load() }, 200) }
await load()
