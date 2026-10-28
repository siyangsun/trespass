import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { applyEdits, parseTres } from '../server/parse-tres.ts'
import { walk, exportsOf, indexGd } from '../server/parse-gd.ts'
import { evalFormula } from '../shared/formula.ts'
import { formatValue, parseValue } from '../shared/values.ts'

const root = path.resolve(process.env.TRES_DIR ?? path.join(import.meta.dirname, '../example'))

test('every .tres round-trips byte-identical', () => {
  const files = walk(root, '.tres')
  assert.ok(files.length > 0, 'no .tres files found')
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8')
    assert.equal(applyEdits(parseTres(text), {}), text, f)
  }
})

test('edits touch only their own lines', () => {
  const text = fs.readFileSync(path.join(root, 'data/goblin.tres'), 'utf8')
  const out = applyEdits(parseTres(text), { hp: '45', flying: 'true', tint: null })
  const a = text.split('\n'), b = out.split('\n')
  assert.equal(b.length, a.length) // 1 replaced, 1 inserted, 1 removed
  assert.ok(b.includes('hp = 45') && b.includes('flying = true') && !b.some((l) => l.startsWith('tint')))
})

test('values format like Godot', () => {
  for (const s of ['1.0', '-2', '"a \\"q\\" \\\\"', '&"x"', 'Color(1, 0.5, 0, 1)', 'Vector2(1, 2)', 'ExtResource("1_ab3")'])
    assert.equal(formatValue(parseValue(s)), s)
  assert.equal(formatValue({ kind: 'float', value: 3 }), '3.0')
})

test('script exports incl. inheritance, enum, default', () => {
  const props = exportsOf('Boss', indexGd(root), root)
  assert.deepEqual(props.map((p) => p.name).slice(-2), ['sprite', 'phases'])
  assert.equal(props.find((p) => p.name === 'tier')?.options?.length, 3)
  assert.equal(props.find((p) => p.name === 'hp')?.def?.kind, 'int')
})

test('formula', () => {
  assert.equal(evalFormula('v * 1.15', 100), 115)
  assert.equal(evalFormula('(v + 5) ** 2', 5), 100)
  assert.throws(() => evalFormula('v; process.exit()', 1))
})
