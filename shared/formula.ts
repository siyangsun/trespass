// Tiny arithmetic evaluator for bulk edits: `v * 1.15`, `(v + 5) ** 2`. No eval().
export function evalFormula(expr: string, v: number): number {
  const toks = [...expr.matchAll(/\s*(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|\*\*|[-+*/%()]|v)\s*/gy)].map((m) => m[1])
  if (toks.join('') !== expr.replace(/\s+/g, '')) throw new Error(`can't parse "${expr}"`)
  let i = 0
  const peek = () => toks[i]
  const atom = (): number => {
    const t = toks[i++]
    if (t === undefined) throw new Error('unexpected end')
    if (t === 'v') return v
    if (t === '(') { const r = sum(); if (toks[i++] !== ')') throw new Error('missing )'); return r }
    if (t === '-') return -pow()
    if (t === '+') return pow()
    const n = Number(t)
    if (Number.isNaN(n)) throw new Error(`unexpected "${t}"`)
    return n
  }
  const pow = (): number => { const b = atom(); return peek() === '**' ? (i++, b ** pow()) : b }
  const prod = (): number => {
    let r = pow()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const o = toks[i++]; const b = pow()
      r = o === '*' ? r * b : o === '/' ? r / b : r % b
    }
    return r
  }
  const sum = (): number => {
    let r = prod()
    while (peek() === '+' || peek() === '-') { const o = toks[i++]; const b = prod(); r = o === '+' ? r + b : r - b }
    return r
  }
  const out = sum()
  if (i < toks.length) throw new Error(`unexpected "${toks[i]}"`)
  if (!Number.isFinite(out)) throw new Error('result is not finite')
  return Math.round(out * 1e6) / 1e6 // hide float noise (100 * 1.15)
}
