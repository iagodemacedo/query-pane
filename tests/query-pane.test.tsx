import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ID = '1b2c3d4e-0000-4abc-8def-123456789abc'
const GiB = 1024 ** 3

const PANE = {
  component: 'Pane',
  requestId: 'query-pane',
  props: { title: 'Athena', isFocused: true, bodyColumns: 100 },
} as const

const ok = (stdout: unknown) => ({
  value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: JSON.stringify(stdout) },
})
const fail = (stderr: string) => ({
  value: { exitCode: 255, stdout: '', isStdoutTruncated: false, isStderrTruncated: false, stderr },
})

const b64 = (s: string) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = [...s].map(c => c.charCodeAt(0))
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = bytes.slice(i, i + 3)
    const n = (a << 16) | (b << 8) | c
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]! + (i + 1 < bytes.length ? A[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? A[n & 63]! : '=')
  }
  return out
}

type World = { sql: string; scanned: number; ran: string[][]; toasts: string[] }

// A fake AWS: the query, Glue (a partitioned table and a view over it), STS and results.
const world = (on: On, w: Partial<World> = {}): World => {
  const state: World = { sql: 'SELECT 1', scanned: 0, ran: [], toasts: [], ...w }
  on('process.run', (_$, e) => {
    const a = e.argv
    state.ran.push([...a])
    if (a[0] === 'open') return ok('')
    if (a[1] === 'sts') return ok({ Account: '123456789012' })
    if (a[2] === 'get-query-execution')
      return ok({
        QueryExecution: {
          Query: state.sql,
          QueryExecutionContext: { Database: 'tracking' },
          Status: { State: 'SUCCEEDED', SubmissionDateTime: '2026-10-14T13:05:09.000-03:00' },
          Statistics: { DataScannedInBytes: state.scanned, EngineExecutionTimeInMillis: 4200 },
        },
      })
    if (a[2] === 'get-query-results')
      return ok({
        ResultSet: {
          ResultSetMetadata: { ColumnInfo: [{ Name: 'customer_id' }, { Name: 'total' }] },
          Rows: [{ Data: [{ VarCharValue: 'customer_id' }, { VarCharValue: 'total' }] }, { Data: [{ VarCharValue: 'c-1' }, { VarCharValue: '42' }] }],
        },
      })
    if (a[1] === 'glue') {
      const name = a[a.indexOf('--name') + 1]
      if (name === 'eventos') return ok({ Table: { PartitionKeys: [{ Name: 'year' }, { Name: 'month' }, { Name: 'day' }] } })
      if (name === 'eventos_view')
        return ok({
          Table: {
            TableType: 'VIRTUAL_VIEW',
            StorageDescriptor: { Columns: [{ Name: 'customer_id' }, { Name: 'year' }, { Name: 'month' }, { Name: 'day' }] },
            ViewOriginalText: `/* Presto View: ${b64(JSON.stringify({ originalSql: 'SELECT e.year FROM\n  (tracking.eventos e\nLEFT JOIN tracking.clientes c USING (id))' }))} */`,
          },
        })
      return fail('EntityNotFoundException')
    }
    return fail('unexpected')
  })
  on('ui.toast', (_$, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return state
}

const runQuery = async ($: Parameters<Parameters<typeof test>[1]>[0], on: On, text = `[athena] QueryExecutionId: ${ID}\nCSV_PATH: /tmp/out/minha query.csv\nROWS: 1.234\n`) => {
  on('tool.call', () => ({ result: {}, text }))
  return $.tool.call({ tool: 'Bash', command: 'python3 run_query.py' } as never)
}

test('query aparece no painel com sql, tamanho, linhas e csv', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { sql: 'SELECT count(*)\n FROM tracking.eventos -- x\n WHERE year = 2026', scanned: 2 * GiB })
  await runQuery($, on)
  await clock.advance(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'query-pane', surface, ...PANE })
    expect(await ui.find({ text: /escaneados · 1 query/ })).toBeDefined()
    expect(await ui.find({ text: /^2 GiB$/ })).toBeDefined()
    expect(await ui.find({ text: /^13:05$/ })).toBeDefined()
    expect(await ui.find({ text: /SELECT count\(\*\) FROM tracking\.eventos WHERE year = 2026/ })).toBeDefined()
    expect(await ui.find({ text: /1\.234 linhas/ })).toBeDefined()
    expect(await ui.find({ text: /csv \/tmp\/out\/minha query\.csv/ })).toBeDefined()
    expect(await ui.find({ text: /possível leitura sem partição/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('view sem filtro de partição gera aviso no card e toast', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { sql: 'SELECT customer_id FROM eventos_view' })
  await runQuery($, on)
  await clock.advance(0)

  const ui = await $.ui.mount({ plugin: 'query-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: /tracking\.eventos_view sem filtro em year, month, day/ })).toBeDefined()
  expect(w.toasts.some(t => /sem filtro de partição/.test(t))).toBe(true)
})

test('query acima do limite vira "query cara" e dispara toast', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { sql: 'SELECT * FROM tracking.eventos WHERE year = 2026', scanned: 12 * GiB })
  await runQuery($, on)
  await clock.advance(0)

  const ui = await $.ui.mount({ plugin: 'query-pane', surface: 'desktop', ...PANE })
  expect(await ui.find({ text: /query cara/ })).toBeDefined()
  expect(w.toasts.some(t => /query cara: 12 GiB/.test(t))).toBe(true)
})

test('limite configurável: 50 GiB não alerta uma query de 12 GiB', { options: { alertGiB: 50 } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { sql: 'SELECT * FROM tracking.eventos WHERE year = 2026', scanned: 12 * GiB })
  await runQuery($, on)
  await clock.advance(0)
  expect(w.toasts.some(t => /query cara/.test(t))).toBe(false)
})

test('prévia, abrir csv e status aws', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await runQuery($, on)
  await clock.advance(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'query-pane', surface, ...PANE })
    await ui.press({ key: `prev-${ID}` })
    expect(await ui.find({ text: /^c-1$/ })).toBeDefined()
    expect(await ui.find({ text: /2 colunas/ })).toBeDefined()
    await ui.press({ key: `prev-${ID}` })
    expect(await ui.find({ text: /^c-1$/ })).toBeUndefined()

    await ui.press({ key: `open-${ID}` })
    await ui.press({ key: `refresh` })
    expect(await ui.find({ text: /aws ok · conta 123456789012/ })).toBeDefined()
    await ui.unmount()
  }
  expect(w.ran.some(a => a[0] === 'open' && a[1] === '/tmp/out/minha query.csv')).toBe(true)
})

test('sessão aws expirada aparece no topo e no card', async ($, on) => {
  on('process.run', () => fail('Your session has expired. Please reauthenticate using aws login.'))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  mock.clock(on)
  const ran = await runQuery($, on, `{"QueryExecutionId": "${ID}"}`)
  expect(ran.deny).toBeUndefined()

  const ui = await $.ui.mount({ plugin: 'query-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: /^aws expirada$/ })).toBeDefined()
  expect(await ui.find({ text: /sessão aws expirada: rode aws login/ })).toBeDefined()
})

test('chamada sem QueryExecutionId não entra no painel', async ($, on) => {
  world(on)
  await runQuery($, on, 'ok')
  const ui = await $.ui.mount({ plugin: 'query-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: /nenhuma query nesta sessão/ })).toBeDefined()
})
