import type { LeaderboardHtmlRow, LeaderboardPuppeteerRenderOptions } from './resource-types'

function calculateViewportWidth(rows: LeaderboardHtmlRow[], baseWidth: number) {
  const longest = Math.max(0, ...rows.map((row) => row.displayName.length))
  const extra = Math.max(0, longest - 14) * 14
  return Math.min(1800, Math.max(baseWidth, baseWidth + extra))
}

export async function renderLeaderboardHtmlToBuffer(params: {
  browser: any
  html: string
  rows: LeaderboardHtmlRow[]
  options: LeaderboardPuppeteerRenderOptions
}) {
  const { browser, html, rows, options } = params
  const page = await browser.newPage()
  try {
    await page.setViewport({
      width: calculateViewportWidth(rows, options.viewportWidth),
      height: 320,
      deviceScaleFactor: options.deviceScaleFactor,
    })
    await page.setContent(html, { waitUntil: options.waitUntil })
    const screenshot = await page.screenshot({ type: 'png', fullPage: true })
    return Buffer.from(screenshot as Uint8Array)
  } finally {
    await page.close()
  }
}
