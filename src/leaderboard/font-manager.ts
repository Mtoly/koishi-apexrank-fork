import { mkdir, readdir, access, copyFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LeaderboardFontDescriptor, LeaderboardFontManagerState } from './resource-types'

const DEFAULT_FONT_FILES = [
  { family: 'Noto Sans CJK SC', fileName: 'NotoSansCJKSC-Regular.otf' },
  { family: 'Noto Sans CJK SC Bold', fileName: 'NotoSansCJKSC-Bold.otf' },
]

async function resolveLeaderboardAssetRoot(assetRoot: string) {
  const candidates = Array.from(new Set([
    resolve(process.cwd(), assetRoot),
    resolve(__dirname, assetRoot),
    resolve(__dirname, '..', assetRoot),
    resolve(__dirname, '..', '..', assetRoot),
  ]))

  for (const candidate of candidates) {
    try {
      await access(join(candidate, 'leaderboard', 'fonts'), fsConstants.F_OK)
      return candidate
    } catch {}
  }

  return candidates[0]
}

export async function ensureLeaderboardFontAssets(assetRoot: string, resourceDir: string) {
  const fontDir = join(resourceDir, 'fonts')
  const resolvedAssetRoot = await resolveLeaderboardAssetRoot(assetRoot)
  await mkdir(fontDir, { recursive: true })
  for (const font of DEFAULT_FONT_FILES) {
    const source = resolve(resolvedAssetRoot, 'leaderboard', 'fonts', font.fileName)
    const target = join(fontDir, font.fileName)
    try {
      await access(target, fsConstants.F_OK)
    } catch {
      try {
        await copyFile(source, target)
      } catch {
        // 静态升级阶段允许资源暂缺；运行时再回退系统字体
      }
    }
  }
  return fontDir
}

export async function loadLeaderboardFonts(resourceDir: string, defaults?: Partial<LeaderboardFontManagerState>) {
  const fontDir = join(resourceDir, 'fonts')
  await mkdir(fontDir, { recursive: true })
  const files = await readdir(fontDir)
  const loadedFonts: LeaderboardFontDescriptor[] = files
    .filter((file) => /\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/.test(file))
    .map((file) => ({
      family: file.replace(/\.[^.]+$/, ''),
      fileName: file,
      cssFamily: file.replace(/\.[^.]+$/, ''),
    }))

  return {
    resourceDir,
    fontDir,
    loadedFonts,
    defaultTitleFont: defaults?.defaultTitleFont || loadedFonts[0]?.cssFamily || 'Noto Sans CJK SC',
    defaultBodyFont: defaults?.defaultBodyFont || loadedFonts[0]?.cssFamily || 'Noto Sans CJK SC',
    defaultNumberFont: defaults?.defaultNumberFont || loadedFonts[0]?.cssFamily || 'Noto Sans CJK SC',
  } satisfies LeaderboardFontManagerState
}

export function buildLeaderboardFontFacesCss(fonts: LeaderboardFontDescriptor[]) {
  return fonts.map((font) => `@font-face { font-family: '${font.cssFamily}'; src: url('fonts/${font.fileName}'); }`).join('\n')
}
