import fs from 'node:fs'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import type { ServerResponse } from 'node:http'

const here = path.resolve(import.meta.dirname, '..')
const TYPES: Record<string, string> = { '.html': 'text/html', '.ts': 'text/javascript', }

/** Serves web/ and shared/; .ts files are type-stripped on the fly for the browser. */
export function serveStatic(url: string, res: ServerResponse): boolean {
  const rel = url === '/' ? '/web/index.html' : url
  if (!/^\/(web|shared)\//.test(rel)) return false
  const file = path.resolve(here, '.' + rel)
  if (!file.startsWith(here + path.sep) || !fs.existsSync(file)) return false
  const ext = path.extname(file)
  let body = fs.readFileSync(file, 'utf8')
  if (ext === '.ts') body = stripTypeScriptTypes(body)
  res.writeHead(200, { 'content-type': (TYPES[ext] ?? 'text/plain') + '; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
  return true
}
