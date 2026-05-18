import type { LeaderboardEntry } from '../shared'

export interface LeaderboardTemplateTheme {
  preset: string
  backgroundType: 'preset' | 'css' | 'file' | 'url' | 'api'
  backgroundValue: string
  customCss: string
  accentColor: string
  surfaceColor: string
  textPrimaryColor: string
  textSecondaryColor: string
  gainColor: string
  lossColor: string
}

export interface LeaderboardHtmlRow {
  rank: number
  avatarCacheKey: string
  avatarUrl: string
  displayName: string
  displayNameTruncated: string
  platformLabel: string
  latestScoreLabel: string
  deltaLabel: string
  deltaDirection: 'gain' | 'loss'
  deltaAbs: number
  barPercent: number
  barWidthCss: string
  avatarBase64?: string
}

export interface LeaderboardHtmlDocument {
  title: string
  subtitle: string
  rows: LeaderboardHtmlRow[]
  periodLabel: string
  directionLabel: string
  theme: LeaderboardTemplateTheme
}

export interface LeaderboardHtmlRenderOptions {
  title: string
  periodLabel: string
  directionLabel: string
  periodRangeText: string
  entries: LeaderboardEntry[]
}

export interface AvatarCacheEntry {
  base64: string
  timestamp: number
  status: 'success' | 'fallback'
  sourceUrl: string
}

export interface LeaderboardAvatarCacheOptions {
  cacheDir: string
  successTtlMs: number
  failureTtlMs: number
  fetchTimeoutMs: number
}

export interface LeaderboardFontDescriptor {
  family: string
  fileName: string
  cssFamily: string
}

export interface LeaderboardFontManagerState {
  resourceDir: string
  fontDir: string
  loadedFonts: LeaderboardFontDescriptor[]
  defaultTitleFont: string
  defaultBodyFont: string
  defaultNumberFont: string
}

export interface LeaderboardResourceLayout {
  rootDir: string
  avatarDir: string
  backgroundDir: string
  fontDir: string
  templateDir: string
}

export interface LeaderboardPuppeteerRenderOptions {
  viewportWidth: number
  deviceScaleFactor: number
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
  maxRowsPerImage: number
}

export interface LeaderboardRuntimeRenderConfig {
  renderMode: 'html' | 'legacy' | 'text'
  enableLegacyImageFallback: boolean
  enableTextFallback: boolean
  resourceDir: string
  avatarCacheTTL: number
  avatarFailureCacheTTL: number
  avatarFetchTimeout: number
  viewportWidth: number
  deviceScaleFactor: number
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
  maxRowsPerImage: number
  titleFont: string
  bodyFont: string
  numberFont: string
  fontFallbackEnabled: boolean
  themePreset: string
  backgroundType: 'preset' | 'css' | 'file' | 'url' | 'api'
  backgroundValue: string
  backgroundApiKey: string
  customCss: string
}
