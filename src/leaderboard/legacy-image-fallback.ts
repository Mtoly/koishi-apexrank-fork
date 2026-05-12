import { h } from 'koishi'
import type { LeaderboardRenderContext, LeaderboardRenderRequest } from './types'

export async function renderLegacyLeaderboardImage(
  request: LeaderboardRenderRequest,
  context: LeaderboardRenderContext,
) {
  const imagePath = await context.imageRenderer.renderLeaderboard(request.entries, {
    periodLabel: request.periodLabel,
    directionLabel: request.directionLabel,
    periodRangeText: request.periodRangeText,
  })
  return h.image(imagePath)
}
