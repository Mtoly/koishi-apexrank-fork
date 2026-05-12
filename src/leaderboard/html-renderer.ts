import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { h } from 'koishi'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { LeaderboardAvatarCache } from './avatar-cache'
import { loadLeaderboardFonts, buildLeaderboardFontFacesCss } from './font-manager'
import { normalizeLeaderboardHtmlRows } from './normalize'
import { renderLeaderboardHtmlToBuffer } from './puppeteer-renderer'
import { ensureLeaderboardResourceLayout, getLeaderboardResourceLayout, reloadLeaderboardResources } from './resource-reloader'
import { buildLeaderboardHtml } from './template'
import { buildLeaderboardBackgroundCss, resolveLeaderboardTheme } from './theme'
import type { LeaderboardRenderContext, LeaderboardRenderRequest } from './types'

const AVATAR_SIZE = 50

async function getAvatarAsBase64(
  avatarUrl: string,
  avatarCache: LeaderboardAvatarCache,
  fetchTimeoutMs: number,
  logger: Pick<LeaderboardRenderContext['logger'], 'warn' | 'error'>,
) {
  if (!avatarUrl) return ''

  const cached = await avatarCache.get(avatarUrl)
  if (cached) return cached.base64

  const now = Date.now()
  let base64 = ''
  let status: 'success' | 'fallback' = 'fallback'

  try {
    const response = await fetch(avatarUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(Math.max(1000, fetchTimeoutMs)),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    const image = await loadImage(Buffer.from(arrayBuffer))
    const canvas = createCanvas(AVATAR_SIZE, AVATAR_SIZE)
    const canvasContext = canvas.getContext('2d')
    canvasContext.drawImage(image, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
    base64 = canvas.toBuffer('image/png').toString('base64')
    status = base64 ? 'success' : 'fallback'
  } catch (error) {
    logger.warn(`leaderboard avatar fetch failed: ${String((error as Error)?.message || error)}`)
  }

  await avatarCache.set({
    base64,
    timestamp: now,
    status,
    sourceUrl: avatarUrl,
  })
  return base64
}

export async function renderHtmlLeaderboard(
  request: LeaderboardRenderRequest,
  context: LeaderboardRenderContext,
) {
  const browser = context.puppeteer?.browser
  if (!browser) throw new Error('puppeteer browser unavailable')

  const runtimeConfig = context.runtimeConfig || {}
  const resourceRoot = context.resourceLayout?.rootDir || runtimeConfig.resourceDir || 'data/apexrankwatch/leaderboard'
  const resourceLayout = context.resourceLayout || getLeaderboardResourceLayout(resourceRoot)

  await ensureLeaderboardResourceLayout(resourceLayout)
  const reloaded = await reloadLeaderboardResources({
    assetRoot: 'assets',
    layout: resourceLayout,
    defaultTitleFont: runtimeConfig.titleFont,
    defaultBodyFont: runtimeConfig.bodyFont,
    defaultNumberFont: runtimeConfig.numberFont,
    enableFontFallback: runtimeConfig.fontFallbackEnabled,
  })
  let fontState = reloaded.fontState
  if (!fontState) {
    fontState = await loadLeaderboardFonts(resourceLayout.rootDir, {
      defaultTitleFont: runtimeConfig.titleFont,
      defaultBodyFont: runtimeConfig.bodyFont,
      defaultNumberFont: runtimeConfig.numberFont,
    })
  }
  const fontFacesCss = buildLeaderboardFontFacesCss(fontState.loadedFonts)

  const theme = resolveLeaderboardTheme({
    themePreset: runtimeConfig.themePreset || 'default',
    backgroundType: runtimeConfig.backgroundType || 'preset',
    backgroundValue: runtimeConfig.backgroundValue || '',
    customCss: runtimeConfig.customCss || '',
  })
  const backgroundCss = await buildLeaderboardBackgroundCss({
    theme,
    backgroundDir: resourceLayout.backgroundDir,
    apiKey: runtimeConfig.backgroundApiKey,
  })

  const avatarCache = new LeaderboardAvatarCache({
    cacheDir: resourceLayout.avatarDir,
    successTtlMs: (runtimeConfig.avatarCacheTTL || 24 * 60 * 60) * 1000,
    failureTtlMs: (runtimeConfig.avatarFailureCacheTTL || 5 * 60) * 1000,
    fetchTimeoutMs: (runtimeConfig.avatarFetchTimeout || 5000),
  })

  const rows = normalizeLeaderboardHtmlRows(request.entries, request.directionLabel, runtimeConfig.maxRowsPerImage || 10)
  for (const row of rows) {
    row.avatarBase64 = await getAvatarAsBase64(
      row.avatarUrl,
      avatarCache,
      runtimeConfig.avatarFetchTimeout || 5000,
      context.logger,
    )
  }

  const resourceBaseHref = pathToFileURL(join(resolve(resourceLayout.rootDir), '/')).href

  const html = buildLeaderboardHtml({
    title: request.title,
    periodRangeText: request.periodRangeText,
    periodLabel: request.periodLabel,
    directionLabel: request.directionLabel,
    rows,
    theme,
    fontFacesCss,
    backgroundCss,
    resourceBaseHref,
    titleFont: fontState.defaultTitleFont,
    bodyFont: fontState.defaultBodyFont,
    numberFont: fontState.defaultNumberFont,
  })

  const imageBuffer = await renderLeaderboardHtmlToBuffer({
    browser,
    html,
    rows,
    options: {
      viewportWidth: runtimeConfig.viewportWidth || 1180,
      deviceScaleFactor: runtimeConfig.deviceScaleFactor || 1,
      waitUntil: runtimeConfig.waitUntil || 'networkidle0',
      maxRowsPerImage: runtimeConfig.maxRowsPerImage || 10,
    },
  })

  return h.image(imageBuffer, 'image/png')
}
