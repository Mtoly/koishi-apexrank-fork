import type { Fragment } from 'koishi'
import { renderHtmlLeaderboard } from './html-renderer'
import { renderLegacyLeaderboardImage } from './legacy-image-fallback'
import { formatLeaderboardText } from './text-fallback'
import type { LeaderboardRenderContext, LeaderboardRenderRequest } from './types'

function finalFailureText(request: LeaderboardRenderRequest, errors: string[]) {
  const lines = [request.title, '⚠️ 榜单渲染失败，请稍后再试。']
  if (errors.length) lines.push(`错误摘要：${errors.join('；')}`)
  return lines.join('\n')
}

export async function renderLeaderboardOutput(
  request: LeaderboardRenderRequest,
  context: LeaderboardRenderContext,
): Promise<Fragment | string> {
  if (!request.entries.length) {
    return formatLeaderboardText(request)
  }

  const mode = request.renderMode ?? 'legacy'
  const allowLegacy = request.enableLegacyImageFallback !== false
  const allowText = request.enableTextFallback !== false
  const errors: string[] = []

  const tryHtml = async () => {
    if (!context.renderHtml) {
      return renderHtmlLeaderboard(request, context)
    }
    return context.renderHtml(request)
  }

  const tryLegacy = async () => renderLegacyLeaderboardImage(request, context)

  const tryText = async () => formatLeaderboardText(request)

  const attempt = async (fn: () => Promise<Fragment | string>, label: string) => {
    try {
      return await fn()
    } catch (error) {
      const message = `${label}: ${String((error as Error)?.message || error)}`
      errors.push(message)
      context.logger.error(message)
      return null
    }
  }

  if (mode === 'text') return tryText()

  if (mode === 'html') {
    const htmlResult = await attempt(tryHtml, 'leaderboard html render failed')
    if (htmlResult) return htmlResult
  }

  if (allowLegacy) {
    const legacyResult = await attempt(tryLegacy, 'leaderboard legacy render failed')
    if (legacyResult) return legacyResult
  }

  if (allowText) {
    return tryText()
  }

  return finalFailureText(request, errors)
}
