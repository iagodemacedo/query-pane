import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AwsStatus, Query } from '../types'

const PANE = 'query-pane'
const TITLE = 'Athena'
const queries = atom({ plugin: 'query-pane', key: 'queries' } as const, [])

// Covers the athena-query skill ("QueryExecutionId: <id>" on stderr), the
// AWS CLI and the Athena MCP (JSON "QueryExecutionId": "<id>").
const ID = /QueryExecutionId["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
const CSV = /CSV(?:_PATH)?:\s*(.+?\.csv)\s*$/m
const ROWS = /^ROWS:\s*([\d.,]+)/m

// A batch-get or a listing can name dozens of ids; only the first few are real work of this call.
const MAX_IDS_PER_CALL = 5
const DONE = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED'])

// Athena on-demand: US$ 5 per TB scanned, 10 MB minimum per query.
const usd = (bytes: number) => (Math.max(bytes, 10e6) / 1e12) * 5

const bytes = (n?: number) => {
  if (n === undefined) return '?'
  const nf = (x: number, d: number) => x.toLocaleString('pt-BR', { maximumFractionDigits: d })
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${nf(n / 1024, 0)} KiB`
  if (n < 1024 ** 3) return `${nf(n / 1024 ** 2, 1)} MiB`
  return `${nf(n / 1024 ** 3, 2)} GiB`
}

const money = (v: number) => (v > 0 && v < 0.01 ? 'menos de us$ 0,01' : `us$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`

// SubmissionDateTime already carries the local offset, so its clock reads as local time.
const hhmm = (q: Query) => q.submittedAt?.slice(11, 16) ?? '--:--'

// Same palette and track as context-bar, so the two read as one family.
const PALETTE = ['#6B9BD1', '#5EC4C9', '#A78BFA', '#86C06C', '#E8C56A', '#F4A6C0', '#E0704F']
const TRACK_HEX = '#8B93A6'
const OK_HEX = '#86C06C'
const RUNNING_HEX = '#E8C56A'
const FAILED_HEX = '#E0704F'
const STATE: Record<string, { label: string; hex: string }> = {
  SUCCEEDED: { label: 'ok', hex: OK_HEX },
  RUNNING: { label: 'rodando', hex: RUNNING_HEX },
  QUEUED: { label: 'na fila', hex: RUNNING_HEX },
  FAILED: { label: 'falhou', hex: FAILED_HEX },
  CANCELLED: { label: 'cancelada', hex: FAILED_HEX },
}

// Absolute size drives the color (cost), relative size drives the length.
const sizeHex = (n?: number) => ((n ?? 0) >= 10 * 1024 ** 3 ? FAILED_HEX : (n ?? 0) >= 1024 ** 3 ? RUNNING_HEX : OK_HEX)

const METER_CELLS = 10
const CELL_MAX = 18
const meterCells = (percent: number) =>
  percent > 0 ? Math.min(METER_CELLS, Math.max(1, Math.round((percent / 100) * METER_CELLS))) : 0

function meterSvg(percent: number, fill: string): string {
  const w = Math.min(100, Math.max(0, percent))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="12" viewBox="0 0 100 6" preserveAspectRatio="none">` +
    `<defs><clipPath id="m"><rect width="100" height="6" rx="3" ry="3"/></clipPath></defs>` +
    `<g clip-path="url(#m)"><rect width="100" height="6" fill="${TRACK_HEX}" fill-opacity="0.22"/>` +
    `<rect width="${w.toFixed(1)}" height="6" fill="${fill}"/></g></svg>`
  )
}

function stripSvg(fill: string, opacity: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="20" viewBox="0 0 100 10" preserveAspectRatio="none">` +
    `<rect width="100" height="10" fill="${fill}" fill-opacity="${opacity}"/></svg>`
  )
}

// Splits `width` cells by share, every non-empty value at least one cell,
// leftovers to the largest remainders.
function allocate(values: number[], width: number): number[] {
  const total = values.reduce((sum, v) => sum + v, 0)
  if (total <= 0 || width <= 0) return values.map(() => 0)
  const raw = values.map(v => (v / total) * width)
  const cells = raw.map((r, i) => ((values[i] ?? 0) > 0 ? Math.max(1, Math.floor(r)) : 0))
  let left = width - cells.reduce((a, b) => a + b, 0)
  const order = raw
    .map((r, i) => ({ i, rem: r - Math.floor(r) }))
    .filter(({ i }) => (values[i] ?? 0) > 0)
    .sort((a, b) => b.rem - a.rem)
  for (let k = 0; left > 0 && order.length > 0; k++) {
    const slot = order[k % order.length]
    if (slot) cells[slot.i] = (cells[slot.i] ?? 0) + 1
    left -= 1
  }
  while (left < 0) {
    const widest = cells.indexOf(Math.max(...cells))
    cells[widest] = (cells[widest] ?? 1) - 1
    left += 1
  }
  return cells
}

const secs = (ms?: number) =>
  ms === undefined ? '?' : `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}s`

const oneLine = (sql?: string) => (sql ?? '').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim()

export const parseResult = (text: string) => {
  const ids = [...new Set([...text.matchAll(ID)].map(m => (m[1] ?? "").toLowerCase()).filter(Boolean))].slice(0, MAX_IDS_PER_CALL)
  const csv = text.match(CSV)?.[1]
  const rowsText = text.match(ROWS)?.[1]
  const rows = rowsText === undefined ? undefined : Number(rowsText.replace(/[.,]/g, ''))

  return { ids, csv, rows }
}

const aws = atom({ plugin: 'query-pane', key: 'aws' } as const, { state: 'unknown' })
const expanded = atom({ plugin: 'query-pane', key: 'expanded' } as const, [])

const EXPIRED = /expired|aws login|Unable to locate credentials|ExpiredToken|InvalidClientTokenId/i
const AWS_EVERY_MS = 60_000
const POLL_EVERY_MS = 5_000
const PREVIEW_ROWS = 5

type Run = { exitCode: number; stdout: string; stderr: string }

const awsRun = async ($: EngineInterface, args: string[]): Promise<Run> => {
  try {
    return await $.process.run(['aws', ...args, '--output', 'json'], { timeoutMs: 15000 })
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: String(err) }
  }
}

// Any AWS call that comes back expired flips the header, without waiting for the next check.
const noteAws = async ($: EngineInterface, run: Run) => {
  if (run.exitCode !== 0 && EXPIRED.test(run.stderr)) {
    await update($, aws, () => ({ state: 'expired' as const }))
  }
}

const checkAws = async ($: EngineInterface) => {
  const run = await awsRun($, ['sts', 'get-caller-identity'])
  const next = (() => {
    if (run.exitCode === 0) {
      try {
        return { state: 'ok' as const, account: String(JSON.parse(run.stdout).Account ?? '') }
      } catch {
        return { state: 'ok' as const }
      }
    }
    if (EXPIRED.test(run.stderr)) return { state: 'expired' as const }
    return { state: 'unknown' as const, detail: run.stderr.trim().split('\n').pop()?.slice(0, 80) }
  })()
  await update($, aws, () => next)
}

const describe = async ($: EngineInterface, id: string): Promise<Partial<Query>> => {
  const run = await awsRun($, ['athena', 'get-query-execution', '--query-execution-id', id])
  await noteAws($, run)
  if (run.exitCode !== 0) {
    return { error: EXPIRED.test(run.stderr) ? 'sessão aws expirada: rode aws login e aperte atualizar' : run.stderr.trim().slice(0, 160) }
  }
  try {
    const qe = JSON.parse(run.stdout).QueryExecution

    return {
      state: qe.Status?.State ?? 'UNKNOWN',
      sql: qe.Query,
      database: qe.QueryExecutionContext?.Database,
      scannedBytes: qe.Statistics?.DataScannedInBytes,
      engineMs: qe.Statistics?.EngineExecutionTimeInMillis,
      outputLocation: qe.ResultConfiguration?.OutputLocation,
      submittedAt: qe.Status?.SubmissionDateTime,
      error: qe.Status?.StateChangeReason ?? '',
    }
  } catch {
    return { error: 'resposta da aws ilegível' }
  }
}

// --- Partition check -------------------------------------------------------
// A table partitioned in Glue (tracking.* by year/month/day), or a view that
// passes those columns through from one, should be filtered on them; one that
// is not reads every partition. The check is textual, so it says "possível".

const stripSql = (sql: string) =>
  sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''").toLowerCase()

const NOT_TABLES = new Set(['select', 'unnest', 'values', 'lateral', 'table'])

const unquote = (s: string) => s.replace(/["`]/g, '')

// Tables after FROM / JOIN, CTE names left out, `db.table` or bare `table`.
export const tablesOf = (sql: string): string[] => {
  const text = stripSql(sql)
  const ctes = new Set([...text.matchAll(/(?:\bwith|,)\s+("?[\w$]+"?)\s+as\s*\(/g)].map(m => unquote(m[1] ?? '')))
  // Glue's own view text opens its FROM with "(" before a join: allow it.
  const found = [...text.matchAll(/\b(?:from|join)\s+\(*\s*((?:"?[\w$-]+"?\.)?"?[\w$-]+"?)/g)]
    .map(m => unquote(m[1] ?? ''))
    .filter(t => t !== '' && !ctes.has(t) && !NOT_TABLES.has(t))
  return [...new Set(found)]
}

// Whether any of `keys` shows up after a WHERE or a JOIN's ON in the query.
export const filtersOn = (sql: string, keys: string[]): boolean => {
  const text = stripSql(sql)
  const tails = [...text.matchAll(/\b(?:where|on)\b/g)].map(m => text.slice(m.index ?? 0))
  return keys.some(k => tails.some(tail => new RegExp(`\\b${k}\\b`).test(tail)))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const fromBase64 = (s: string) => {
  let bits = 0
  let acc = 0
  const out: number[] = []
  for (const ch of s.replace(/[^A-Za-z0-9+/]/g, '')) {
    acc = (acc << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  return decodeURIComponent(out.map(b => `%${b.toString(16).padStart(2, '0')}`).join(''))
}

type TableInfo = { keys: string[]; columns: string[]; viewSql?: string }
const tableCache = new Map<string, Promise<TableInfo | null>>()

const tableInfo = ($: EngineInterface, db: string, name: string) => {
  const key = `${db}.${name}`
  let hit = tableCache.get(key)
  if (hit === undefined) {
    hit = (async () => {
      const run = await awsRun($, ['glue', 'get-table', '--database-name', db, '--name', name])
      await noteAws($, run)
      if (run.exitCode !== 0) return null
      try {
        const t = JSON.parse(run.stdout).Table
        const view = /Presto View: (\S+) \*\//.exec(t.ViewOriginalText ?? '')?.[1]
        return {
          keys: (t.PartitionKeys ?? []).map((k: { Name: string }) => k.Name.toLowerCase()),
          columns: (t.StorageDescriptor?.Columns ?? []).map((c: { Name: string }) => c.Name.toLowerCase()),
          viewSql: view === undefined ? undefined : JSON.parse(fromBase64(view)).originalSql,
        }
      } catch {
        return null
      }
    })()
    tableCache.set(key, hit)
  }
  return hit
}

// The partition columns a reader of `db.name` should filter on: its own, or for
// a view, those of the partitioned tables under it that the view exposes.
const requiredKeys = async ($: EngineInterface, db: string, name: string): Promise<string[]> => {
  const info = await tableInfo($, db, name)
  if (info === null) return []
  if (info.keys.length > 0) return info.keys
  if (info.viewSql === undefined) return []
  const keys = new Set<string>()
  for (const base of tablesOf(info.viewSql)) {
    const [bdb, bname] = base.includes('.') ? base.split('.') : [db, base]
    const b = await tableInfo($, bdb ?? db, bname ?? base)
    for (const k of b?.keys ?? []) if (info.columns.includes(k)) keys.add(k)
  }
  return [...keys]
}

const analyze = async ($: EngineInterface, id: string, alertGiB: number) => {
  const q = (await read($, queries)).find(one => one.id === id)
  if (q === undefined) return

  if (!q.isAnalyzed && q.sql !== undefined) {
    const warnings: string[] = []
    for (const t of tablesOf(q.sql)) {
      const [db, name] = t.includes('.') ? t.split('.') : [q.database, t]
      if (db === undefined || name === undefined) continue
      const keys = await requiredKeys($, db, name)
      if (keys.length > 0 && !filtersOn(q.sql, keys)) warnings.push(`${db}.${name} sem filtro em ${keys.join(', ')}`)
    }
    await upsert($, id, { isAnalyzed: true, partitionWarnings: warnings })
    if (warnings.length > 0) {
      $.ui.toast(`possível query sem filtro de partição: ${warnings[0]}`)
    }
  }

  const scanned = q.scannedBytes ?? 0
  if (!q.isCostAlerted && DONE.has(q.state) && scanned >= alertGiB * 1024 ** 3) {
    await upsert($, id, { isCostAlerted: true })
    $.ui.toast(`query cara: ${bytes(scanned)} escaneados, ≈ ${money(usd(scanned))}`)
  }
}

const loadPreview = async ($: EngineInterface, id: string) => {
  const run = await awsRun($, ['athena', 'get-query-results', '--query-execution-id', id, '--max-results', String(PREVIEW_ROWS + 1)])
  await noteAws($, run)
  if (run.exitCode !== 0) {
    await upsert($, id, { previewError: EXPIRED.test(run.stderr) ? 'sessão aws expirada' : run.stderr.trim().slice(0, 120) })
    return
  }
  try {
    const rs = JSON.parse(run.stdout).ResultSet
    const columns: string[] = (rs.ResultSetMetadata?.ColumnInfo ?? []).map((c: { Name: string }) => c.Name)
    const rows: string[][] = (rs.Rows ?? []).map((r: { Data?: { VarCharValue?: string }[] }) =>
      (r.Data ?? []).map(d => d.VarCharValue ?? 'null'),
    )
    // The first row of a SELECT's results repeats the header.
    const body = rows.length > 0 && rows[0]?.join('\u0000') === columns.join('\u0000') ? rows.slice(1) : rows
    await upsert($, id, { columns, preview: body.slice(0, PREVIEW_ROWS), previewError: undefined })
  } catch {
    await upsert($, id, { previewError: 'resposta da aws ilegível' })
  }
}

const toggle = async ($: EngineInterface, id: string) => {
  const isOpen = (await read($, expanded)).includes(id)
  await update($, expanded, ids => (isOpen ? ids.filter(x => x !== id) : [...ids, id]))
  const q = (await read($, queries)).find(one => one.id === id)
  if (!isOpen && q !== undefined && q.preview === undefined && q.state === 'SUCCEEDED') {
    await loadPreview($, id)
  }
}

// The path comes from a tool's output, so `open` only ever gets an existing local
// .csv file: never a URL, an app bundle or anything a crafted output could name.
export const isOpenableCsv = (path: string) => path.startsWith('/') && /\.csv$/i.test(path) && !path.includes('\0')

const openFile = async ($: EngineInterface, path: string, reveal: boolean) => {
  const stat = isOpenableCsv(path) ? await $.fs.stat(path).catch(() => undefined) : undefined
  if (stat?.kind !== 'file') {
    $.ui.toast(`não abri ${path}: não é um arquivo .csv local`)
    return
  }
  const run = await $.process.run(reveal ? ['open', '-R', '--', path] : ['open', '--', path]).catch(() => ({ exitCode: 1 }))
  if (run.exitCode !== 0) $.ui.toast(`não consegui abrir ${path}`)
}

const upsert = ($: EngineInterface, id: string, patch: Partial<Query>) =>
  update($, queries, list => {
    const found = list.some(q => q.id === id)
    const next = found
      ? list.map(q => (q.id === id ? { ...q, ...patch, rows: patch.rows ?? q.rows, csv: patch.csv ?? q.csv } : q))
      : [...list, { id, tool: '', state: 'RUNNING', ...patch }]

    return next.slice(-100)
  })

const refresh = async ($: EngineInterface, alertGiB: number) => {
  const pending = (await read($, queries)).filter(q => !DONE.has(q.state))
  await Promise.all(
    pending.map(async q => {
      await upsert($, q.id, await describe($, q.id))
      await analyze($, q.id, alertGiB)
    }),
  )
}

export const register: Register = (on, options) => {
  const alertGiB = typeof options.alertGiB === 'number' && options.alertGiB > 0 ? options.alertGiB : 10
  let isPolling = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'queries',
      description: 'Abre o painel com as queries do Athena desta sessão',
    })
    $.clock.after(0, () => void checkAws($))
    $.clock.every(AWS_EVERY_MS, () => void checkAws($))
    // Running queries settle on their own: their final size, and any alert, land without a press.
    $.clock.every(POLL_EVERY_MS, () => {
      if (isPolling) return
      isPolling = true
      void refresh($, alertGiB).finally(() => {
        isPolling = false
      })
    })

    return next(e)
  })

  on('command.run', { command: 'queries' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    const n = (await read($, queries)).length

    return { text: n === 0 ? 'Painel aberto. Nenhuma query do Athena nesta sessão ainda.' : `Painel aberto com ${n} queries.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const text = ran.text
    if (text === undefined || !/QueryExecutionId/i.test(text)) {
      return ran
    }

    const { ids, csv, rows } = parseResult(text)
    // CSV and row count only make sense when the call ran one query.
    const single = ids.length === 1
    for (const id of ids) {
      await upsert($, id, { tool: e.tool, ...(single ? { csv, rows } : {}) })
      await upsert($, id, await describe($, id))
    }
    if (ids.length > 0) {
      // Glue lookups run after the tool answers, so the model is not kept waiting.
      $.clock.after(0, () => {
        void (async () => {
          for (const id of ids) await analyze($, id, alertGiB)
        })()
      })
      // No surface to seat a pane (headless run): the data still lands in state for /queries.
      void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // Svg is the desktop's own element; the terminal draws the same shapes in block characters.
    const Svg = e.surface === 'desktop' ? $.ui.resolve(e).Svg : undefined
    const list = (await read($, queries)).slice().reverse()
    const status = await read($, aws)
    const open = await read($, expanded)
    // Card border (2) and padding (2) come off the pane's width.
    const inner = Math.max(24, e.props.bodyColumns - 4)
    const awsLine = (s: AwsStatus) =>
      s.state === 'ok' ? (
        <Text>
          <Text color={OK_HEX}>● </Text>
          <Text dimColor>aws ok{s.account ? ` · conta ${s.account}` : ''}</Text>
        </Text>
      ) : s.state === 'expired' ? (
        <Text>
          <Text color={FAILED_HEX}>● </Text>
          <Text color={FAILED_HEX}>aws expirada</Text>
          <Text dimColor> · rode aws login no terminal</Text>
        </Text>
      ) : (
        <Text>
          <Text dimColor>● aws ?{s.detail ? ` · ${s.detail}` : ''}</Text>
        </Text>
      )

    if (list.length === 0) {
      return (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold>athena</Text>
            {awsLine(status)}
          </Box>
          <Text dimColor>nenhuma query nesta sessão ainda</Text>
          <Box marginTop={1}>
            <Text dimColor>aparece aqui toda query da skill athena-query, do aws cli ou do mcp do athena</Text>
          </Box>
        </Box>
      )
    }

    const scanned = list.reduce((sum, q) => sum + (q.scannedBytes ?? 0), 0)
    const cost = list.reduce((sum, q) => sum + (q.scannedBytes === undefined ? 0 : usd(q.scannedBytes)), 0)
    const biggest = Math.max(1, ...list.map(q => q.scannedBytes ?? 0))
    const colorOf = (q: Query) => PALETTE[(list.length - 1 - list.indexOf(q)) % PALETTE.length] ?? TRACK_HEX

    // The session bar: one segment per query, sized by bytes scanned, in the
    // query's own color, its label on hover.
    const cells = allocate(list.map(q => q.scannedBytes ?? 0), inner)
    let start = 0
    const bar = (
      <Box>
        {scanned === 0 ? (
          Svg !== undefined ? (
            <Svg source={stripSvg(TRACK_HEX, 0.22)} alt="nada escaneado" height={10} />
          ) : (
            <Text dimColor>{'░'.repeat(inner)}</Text>
          )
        ) : (
          list.map((q, i) => {
            const n = cells[i] ?? 0
            const at = start
            start += n
            if (n <= 0) return null
            const label = `${hhmm(q)} · ${bytes(q.scannedBytes)} · ${oneLine(q.sql).slice(0, 40)}`
            const left = Math.max(-at, Math.min(0, inner - (at + label.length)))
            return (
              <Box key={`seg-${q.id}`} width={n}>
                {Svg !== undefined ? (
                  <Svg source={stripSvg(colorOf(q), 1)} alt={label} height={10} />
                ) : (
                  <Text color={colorOf(q)}>{'█'.repeat(n)}</Text>
                )}
                <Box position="absolute" top={1} left={left} display="none" hover={{ display: 'flex' }}>
                  <Text>{label}</Text>
                </Box>
              </Box>
            )
          })
        )}
      </Box>
    )

    const summary = (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold>athena</Text>
          <Text>
            <Text bold>{bytes(scanned)}</Text>
            <Text dimColor>
              {' '}escaneados · {list.length} {list.length === 1 ? 'query' : 'queries'} · ≈ {money(cost)}
            </Text>
          </Text>
        </Box>
        {bar}
        <Box marginTop={1} justifyContent="space-between" alignItems="center">
          {awsLine(status)}
          <Button key="refresh" label="atualizar" hotkey="r" onPress={() => Promise.all([refresh($, alertGiB), checkAws($)])} />
        </Box>
        <Text dimColor>us$ 5 por tb, mínimo de 10 mb · alerta a partir de {alertGiB} gib</Text>
      </Box>
    )

    // The first rows of the result, each column as wide as its widest cell up to
    // a cap, the columns that do not fit counted rather than squeezed.
    const previewTable = (q: Query) => {
      if (q.previewError !== undefined) {
        return (
          <Box marginTop={1}>
            <Text color={FAILED_HEX}>prévia indisponível: {q.previewError}</Text>
          </Box>
        )
      }
      if (q.preview === undefined || q.columns === undefined) {
        return (
          <Box marginTop={1}>
            <Text dimColor>carregando prévia…</Text>
          </Box>
        )
      }
      const cols = q.columns
      const widths = cols.map((c, i) => Math.min(CELL_MAX, Math.max(c.length, ...(q.preview ?? []).map(r => (r[i] ?? '').length)) + 2))
      let room = inner - 2
      const shown = widths.filter(w => (room -= w) >= 0).length || 1
      const cell = (v: string, w: number) => (v.length > w - 2 ? `${v.slice(0, w - 3)}…` : v)
      const row = (values: string[], key: string, isHead: boolean) => (
        <Box key={key}>
          {values.slice(0, shown).map((v, i) => (
            <Box width={widths[i] ?? CELL_MAX}>
              <Text bold={isHead} dimColor={isHead} wrap="truncate-end">
                {cell(v, widths[i] ?? CELL_MAX)}
              </Text>
            </Box>
          ))}
        </Box>
      )
      return (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderDimColor paddingX={1}>
          {row(cols, `head-${q.id}`, true)}
          {q.preview.length === 0 ? <Text dimColor>sem linhas</Text> : q.preview.map((r, i) => row(r, `row-${q.id}-${i}`, false))}
          <Text dimColor>
            {cols.length} {cols.length === 1 ? 'coluna' : 'colunas'}
            {shown < cols.length ? ` · ${cols.length - shown} fora da tela` : ''} · primeiras {q.preview.length} linhas
          </Text>
        </Box>
      )
    }

    const card = (q: Query) => {
      const look = STATE[q.state] ?? { label: q.state.toLowerCase(), hex: RUNNING_HEX }
      const percent = ((q.scannedBytes ?? 0) / biggest) * 100
      const meter = Svg !== undefined ? (
        <Svg source={meterSvg(percent, sizeHex(q.scannedBytes))} alt={`${bytes(q.scannedBytes)} escaneados`} width={96} height={8} />
      ) : (
        <Text>
          <Text color={sizeHex(q.scannedBytes)}>{'█'.repeat(meterCells(percent))}</Text>
          <Text dimColor>{'░'.repeat(METER_CELLS - meterCells(percent))}</Text>
        </Text>
      )
      const meta = [secs(q.engineMs), q.rows === undefined ? null : `${q.rows.toLocaleString('pt-BR')} linhas`, short(q.id)]
        .filter(Boolean)
        .join(' · ')
      const hasError = q.error !== undefined && q.error !== ''
      const isExpensive = (q.scannedBytes ?? 0) >= alertGiB * 1024 ** 3
      const isOpen = open.includes(q.id)
      const canPreview = q.state === 'SUCCEEDED'

      return (
        <Box key={`q-${q.id}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
          <Box justifyContent="space-between" alignItems="center">
            <Text>
              <Text color={colorOf(q)}>● </Text>
              <Text bold>{hhmm(q)}</Text>
              <Text color={look.hex}>  {look.label}</Text>
              {isExpensive && <Text color={FAILED_HEX} bold>  query cara</Text>}
            </Text>
            <Box alignItems="center" columnGap={1}>
              {meter}
              <Box width={10} justifyContent="flex-end">
                <Text bold>{bytes(q.scannedBytes)}</Text>
              </Box>
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text wrap="truncate-end">{oneLine(q.sql) || 'sql ainda não lido'}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{meta}</Text>
          {q.csv !== undefined && (
            <Text dimColor wrap="truncate-start">
              csv {q.csv}
            </Text>
          )}
          {hasError && (
            <Text color={FAILED_HEX} wrap="truncate-end">
              {q.error}
            </Text>
          )}
          {(q.partitionWarnings ?? []).map(w => (
            <Text color={RUNNING_HEX} wrap="truncate-end">
              ⚠ possível leitura sem partição: {w}
            </Text>
          ))}
          {isOpen && previewTable(q)}
          <Box marginTop={1} columnGap={2} flexWrap="wrap">
            {canPreview && (
              <Button key={`prev-${q.id}`} label={isOpen ? 'esconder prévia' : 'ver prévia'} onPress={() => toggle($, q.id)} />
            )}
            {q.csv !== undefined && (
              <Button key={`open-${q.id}`} label="abrir csv" onPress={() => openFile($, q.csv ?? '', false)} />
            )}
            {q.csv !== undefined && (
              <Button key={`finder-${q.id}`} label="mostrar no finder" onPress={() => openFile($, q.csv ?? '', true)} />
            )}
            {q.sql !== undefined && (
              <Button key={`sql-${q.id}`} label="copiar sql" onPress={() => $.ui.copy({ text: q.sql ?? '', surface: e.surface })} />
            )}
            <Button key={`id-${q.id}`} label="copiar id" onPress={() => $.ui.copy({ text: q.id, surface: e.surface })} />
            {q.csv !== undefined && (
              <Button key={`csv-${q.id}`} label="copiar caminho do csv" onPress={() => $.ui.copy({ text: q.csv ?? '', surface: e.surface })} />
            )}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {summary}
        {list.map(card)}
      </Box>
    )
  })
}
