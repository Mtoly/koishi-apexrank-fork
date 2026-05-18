import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildLeaderboardFontFacesCss, loadLeaderboardFonts } from '../leaderboard/font-manager'
import { renderLeaderboardHtmlToBuffer } from '../leaderboard/puppeteer-renderer'
import { ensureLeaderboardResourceLayout, getLeaderboardResourceLayout, reloadLeaderboardResources } from '../leaderboard/resource-reloader'
import { buildLeaderboardBackgroundCss, resolveLeaderboardTheme } from '../leaderboard/theme'
import { buildHtmlCardDocumentHtml } from './shared-template'
import type { HtmlCardDocument, HtmlCardRenderContext, HtmlCardResourceLayout } from './types'

function resolveHtmlCardResourceLayout(rootDir: string): HtmlCardResourceLayout {
  return getLeaderboardResourceLayout(rootDir)
}

function resolveHtmlCardResourceBaseHref(rootDir: string) {
  const href = pathToFileURL(resolve(rootDir)).href
  return href.endsWith('/') ? href : `${href}/`
}

function ensureNonEmptyBuffer(bufferLike: unknown) {
  if (Buffer.isBuffer(bufferLike)) {
    if (!bufferLike.length) throw new Error('html card render returned empty buffer')
    return bufferLike
  }

  if (bufferLike instanceof Uint8Array) {
    const buffer = Buffer.from(bufferLike)
    if (!buffer.length) throw new Error('html card render returned empty buffer')
    return buffer
  }

  if (bufferLike instanceof ArrayBuffer) {
    const buffer = Buffer.from(bufferLike)
    if (!buffer.length) throw new Error('html card render returned empty buffer')
    return buffer
  }

  throw new Error('html card render returned invalid buffer')
}

/**
 * Shared HTML card renderer for help / predator / season cards.
 * Callers own the HTML -> legacy -> text fallback sequencing.
 */
export async function renderHtmlCardToBuffer(params: {
  document: HtmlCardDocument
  context: HtmlCardRenderContext
}): Promise<Buffer> {
  const { document, context } = params
  const browser = context.puppeteer?.browser
  if (!browser) throw new Error('puppeteer browser unavailable')

  const runtimeConfig = context.runtimeConfig || {}
  const resourceRoot = context.resourceLayout?.rootDir || runtimeConfig.resourceDir || 'data/apexrankwatch/leaderboard'
  const resourceLayout = context.resourceLayout || resolveHtmlCardResourceLayout(resourceRoot)

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

  const theme = resolveLeaderboardTheme({
    themePreset: runtimeConfig.themePreset || 'apex-red',
    backgroundType: runtimeConfig.backgroundType || 'preset',
    backgroundValue: runtimeConfig.backgroundValue || '',
    customCss: runtimeConfig.customCss || '',
  })

  const backgroundCss = await buildLeaderboardBackgroundCss({
    theme,
    backgroundDir: resourceLayout.backgroundDir,
    apiKey: runtimeConfig.backgroundApiKey,
  })

  const fontFacesCss = buildLeaderboardFontFacesCss(fontState.loadedFonts)
  const resourceBaseHref = resolveHtmlCardResourceBaseHref(resourceLayout.rootDir)
  const html = buildHtmlCardDocumentHtml({
    document,
    theme,
    fontFacesCss,
    backgroundCss,
    resourceBaseHref,
    titleFont: fontState.defaultTitleFont,
    bodyFont: fontState.defaultBodyFont,
    numberFont: fontState.defaultNumberFont,
    customCss: runtimeConfig.customCss || '',
  })

  const imageBuffer = await renderLeaderboardHtmlToBuffer({
    browser,
    html,
    rows: [],
    options: {
      viewportWidth: runtimeConfig.viewportWidth || 1180,
      deviceScaleFactor: runtimeConfig.deviceScaleFactor || 1,
      waitUntil: runtimeConfig.waitUntil || 'networkidle0',
      maxRowsPerImage: 1,
    },
  })

  return ensureNonEmptyBuffer(imageBuffer)
}
