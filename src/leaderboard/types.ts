import type { Fragment } from 'koishi'
import type { LeaderboardEntry, LoggerLike } from '../shared'
import type { LeaderboardPuppeteerRenderOptions, LeaderboardRuntimeRenderConfig, LeaderboardResourceLayout } from './resource-types'

export type LeaderboardRenderMode = 'html' | 'legacy' | 'text'

export interface LeaderboardRenderOptions {
  periodLabel: string
  directionLabel: string
  periodRangeText: string
}

export interface LeaderboardImageRenderer {
  renderLeaderboard(entries: LeaderboardEntry[], options: LeaderboardRenderOptions): Promise<string>
}

export interface LeaderboardRenderRequest extends LeaderboardRenderOptions {
  entries: LeaderboardEntry[]
  title: string
  renderMode?: LeaderboardRenderMode
  enableLegacyImageFallback?: boolean
  enableTextFallback?: boolean
}

export interface LeaderboardRenderContext {
  imageRenderer: LeaderboardImageRenderer
  logger: Pick<LoggerLike, 'error' | 'warn'>
  renderHtml?: (request: LeaderboardRenderRequest) => Promise<Fragment | string>
  runtimeConfig?: Partial<LeaderboardRuntimeRenderConfig>
  resourceLayout?: LeaderboardResourceLayout
  puppeteer?: {
    browser?: unknown
  }
}
