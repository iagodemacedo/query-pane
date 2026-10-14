export type Query = {
  id: string
  tool: string
  state: string
  sql?: string
  database?: string
  scannedBytes?: number
  engineMs?: number
  rows?: number
  csv?: string
  outputLocation?: string
  submittedAt?: string
  error?: string
  // One line per table read without a filter on its partition columns.
  partitionWarnings?: string[]
  isAnalyzed?: boolean
  isCostAlerted?: boolean
  columns?: string[]
  preview?: string[][]
  previewError?: string
}

export type AwsStatus = {
  state: 'ok' | 'expired' | 'unknown'
  account?: string
  detail?: string
}

declare module 'claude-code' {
  interface PluginState {
    'query-pane': { queries: Query[]; aws: AwsStatus; expanded: string[] }
  }
}
