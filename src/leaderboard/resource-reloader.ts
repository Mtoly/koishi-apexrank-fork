import { mkdir, access, readdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import type { LeaderboardFontManagerState, LeaderboardResourceLayout } from './resource-types'
import { ensureLeaderboardFontAssets, loadLeaderboardFonts } from './font-manager'

export function getLeaderboardResourceLayout(rootDir: string): LeaderboardResourceLayout {
  return {
    rootDir,
    avatarDir: join(rootDir, 'avatars'),
    backgroundDir: join(rootDir, 'backgrounds'),
    fontDir: join(rootDir, 'fonts'),
    templateDir: join(rootDir, 'templates'),
  }
}

export async function ensureLeaderboardResourceLayout(layout: LeaderboardResourceLayout) {
  await mkdir(layout.rootDir, { recursive: true })
  await mkdir(layout.avatarDir, { recursive: true })
  await mkdir(layout.backgroundDir, { recursive: true })
  await mkdir(layout.fontDir, { recursive: true })
  await mkdir(layout.templateDir, { recursive: true })
}

export async function listLeaderboardBackgroundFiles(layout: LeaderboardResourceLayout) {
  await mkdir(layout.backgroundDir, { recursive: true })
  return readdir(layout.backgroundDir)
}

export async function resolveLeaderboardBackgroundFile(layout: LeaderboardResourceLayout, fileName: string) {
  const fullPath = join(layout.backgroundDir, fileName)
  try {
    await access(fullPath, fsConstants.F_OK)
    return fullPath
  } catch {
    return ''
  }
}

export async function reloadLeaderboardResources(params: {
  assetRoot: string
  layout: LeaderboardResourceLayout
  defaultTitleFont?: string
  defaultBodyFont?: string
  defaultNumberFont?: string
  enableFontFallback?: boolean
}) {
  await ensureLeaderboardResourceLayout(params.layout)

  let fontState: LeaderboardFontManagerState | undefined
  if (params.enableFontFallback !== false) {
    await ensureLeaderboardFontAssets(params.assetRoot, params.layout.rootDir)
    fontState = await loadLeaderboardFonts(params.layout.rootDir, {
      defaultTitleFont: params.defaultTitleFont,
      defaultBodyFont: params.defaultBodyFont,
      defaultNumberFont: params.defaultNumberFont,
    })
  }

  const backgroundFiles = await listLeaderboardBackgroundFiles(params.layout)
  return {
    reloadedAt: Date.now(),
    fontState,
    backgroundFiles,
  }
}
