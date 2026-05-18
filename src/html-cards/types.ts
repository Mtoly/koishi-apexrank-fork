import type { LoggerLike } from '../shared'

export type HtmlCardBackgroundType = 'preset' | 'css' | 'file' | 'url' | 'api'
export type HtmlCardWaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'

export interface HtmlCardMetaItem {
  label: string
  value: string
}

export interface HtmlCardSectionItem {
  title: string
  description?: string
}

export interface HtmlCardKeyValueRow {
  label: string
  value: string
}

export interface HtmlCardRichListItem {
  title: string
  description?: string
}

export type HtmlCardListItem = string | HtmlCardRichListItem

export interface HtmlCardSectionBlock {
  type: 'section'
  title: string
  description?: string
  items?: HtmlCardSectionItem[]
}

export interface HtmlCardKeyValueBlock {
  type: 'key-value'
  title?: string
  rows: HtmlCardKeyValueRow[]
}

export interface HtmlCardListBlock {
  type: 'list'
  title?: string
  items: HtmlCardListItem[]
}

export interface HtmlCardTableBlock {
  type: 'table'
  title?: string
  columns: string[]
  rows: string[][]
}

export interface HtmlCardTipBlock {
  type: 'tip'
  title?: string
  content: string
  variant?: 'info' | 'warn' | 'success'
}

export type HtmlCardBlock =
  | HtmlCardSectionBlock
  | HtmlCardKeyValueBlock
  | HtmlCardListBlock
  | HtmlCardTableBlock
  | HtmlCardTipBlock

export interface HtmlCardDocument {
  title: string
  subtitle?: string
  metaItems?: HtmlCardMetaItem[]
  blocks: HtmlCardBlock[]
  footer?: string
}

export interface HtmlCardResourceLayout {
  rootDir: string
  avatarDir: string
  backgroundDir: string
  fontDir: string
  templateDir: string
}

export interface HtmlCardRuntimeRenderConfig {
  resourceDir: string
  viewportWidth: number
  deviceScaleFactor: number
  waitUntil: HtmlCardWaitUntil
  titleFont: string
  bodyFont: string
  numberFont: string
  fontFallbackEnabled: boolean
  themePreset: string
  backgroundType: HtmlCardBackgroundType
  backgroundValue: string
  backgroundApiKey: string
  customCss: string
}

export interface HtmlCardRenderContext {
  logger: Pick<LoggerLike, 'error' | 'warn'>
  runtimeConfig?: Partial<HtmlCardRuntimeRenderConfig>
  resourceLayout?: HtmlCardResourceLayout
  puppeteer?: {
    browser?: unknown
  }
}
