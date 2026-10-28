export type Prop = { name: string; start: number; end: number; raw: string }
export type Tres = {
  lines: string[]
  eol: string
  header: Record<string, string>
  ext: Record<string, { type: string; path: string }>
  props: Map<string, Prop>
  /** line index where new [resource] properties get inserted */
  insertAt: number
}

const attrs = (s: string) =>
  Object.fromEntries([...s.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|[^\s\]]+)/g)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')]))

/** Track open string / bracket depth so multi-line values are kept whole. */
function scan(s: string, st: { str: boolean; depth: number }) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (st.str) { if (c === '\\') i++; else if (c === '"') st.str = false }
    else if (c === '"') st.str = true
    else if ('[{('.includes(c)) st.depth++
    else if (']})'.includes(c)) st.depth--
  }
}

export function parseTres(text: string): Tres {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(eol)
  const t: Tres = { lines, eol, header: {}, ext: {}, props: new Map(), insertAt: lines.length }
  let sec = ''
  for (let i = 0; i < lines.length; i++) {
    const h = /^\[(\w+)(.*)\]\s*$/.exec(lines[i])
    if (h) {
      sec = h[1]
      if (sec === 'gd_resource') t.header = attrs(h[2])
      else if (sec === 'ext_resource') { const a = attrs(h[2]); t.ext[a.id] = { type: a.type, path: a.path } }
      else if (sec === 'resource') t.insertAt = i + 1
      continue
    }
    if (sec !== 'resource') continue
    const p = /^([\w/.:-]+)\s*=\s*(.*)$/.exec(lines[i])
    if (!p) continue
    const start = i
    const st = { str: false, depth: 0 }
    let raw = p[2]
    scan(raw, st)
    while ((st.str || st.depth > 0) && i + 1 < lines.length) { i++; raw += eol + lines[i]; scan(lines[i], st) }
    raw = raw.trim()
    t.props.set(p[1], { name: p[1], start, end: i, raw })
    t.insertAt = i + 1
  }
  return t
}

/**
 * Line-level writer: only touched properties change. raw = new value text, null = drop the line
 * (property back at its script default). Everything else passes through byte-for-byte.
 */
export function applyEdits(t: Tres, edits: Record<string, string | null>): string {
  const byStart = new Map([...t.props.values()].map((p) => [p.start, p]))
  const add = Object.entries(edits).flatMap(([k, raw]) => (raw !== null && !t.props.has(k) ? [`${k} = ${raw}`] : []))
  const out: string[] = []
  for (let i = 0; i < t.lines.length; i++) {
    if (i === t.insertAt) out.push(...add)
    const p = byStart.get(i)
    if (p && p.name in edits) {
      const raw = edits[p.name]
      if (raw !== null) out.push(`${p.name} = ${raw}`)
      i = p.end
    } else out.push(t.lines[i])
  }
  if (t.insertAt >= t.lines.length) out.push(...add)
  return out.join(t.eol)
}

export type DiffLine = { type: '-' | '+'; n: number; text: string }

/** Changed lines only (prefix/suffix trimmed, LCS on the middle). n = 1-based line in old (-) or new (+). */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n'), y = b.split('\n')
  let s = 0
  while (s < x.length && s < y.length && x[s] === y[s]) s++
  let e = 0
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++
  const p = x.slice(s, x.length - e), q = y.slice(s, y.length - e)
  const L = Array.from({ length: p.length + 1 }, () => new Array<number>(q.length + 1).fill(0))
  for (let i = p.length - 1; i >= 0; i--)
    for (let j = q.length - 1; j >= 0; j--) L[i][j] = p[i] === q[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < p.length || j < q.length) {
    if (i < p.length && j < q.length && p[i] === q[j]) { i++; j++ }
    else if (j >= q.length || (i < p.length && L[i + 1][j] >= L[i][j + 1])) { out.push({ type: '-', n: s + i + 1, text: p[i] }); i++ }
    else { out.push({ type: '+', n: s + j + 1, text: q[j] }); j++ }
  }
  return out
}
