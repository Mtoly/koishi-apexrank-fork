import { readFile } from 'node:fs/promises'
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
  const imageBuffer = await readFile(imagePath)
  return h.image(imageBuffer, 'image/png')
}
