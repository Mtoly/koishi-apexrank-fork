import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { LeaderboardTemplateTheme } from './resource-types'
import { resolveLeaderboardBackgroundFile } from './resource-reloader'

const PRESETS: Record<string, Omit<LeaderboardTemplateTheme, 'backgroundType' | 'backgroundValue' | 'customCss'>> = {
  default: {
    preset: 'default',
    accentColor: '#e53935',
    surfaceColor: '#121418',
    textPrimaryColor: '#f5f6f8',
    textSecondaryColor: '#c7cdd8',
    gainColor: '#58d27e',
    lossColor: '#ee3e42',
  },
  dark: {
    preset: 'dark',
    accentColor: '#8ab4f8',
    surfaceColor: '#0f1115',
    textPrimaryColor: '#ffffff',
    textSecondaryColor: '#d0d6df',
    gainColor: '#34d399',
    lossColor: '#f87171',
  },
  'apex-red': {
    preset: 'apex-red',
    accentColor: '#da3134',
    surfaceColor: '#121317',
    textPrimaryColor: '#fbfbfb',
    textSecondaryColor: '#cfd5de',
    gainColor: '#72f0a3',
    lossColor: '#ff6b6b',
  },
  minimal: {
    preset: 'minimal',
    accentColor: '#4f46e5',
    surfaceColor: '#ffffff',
    textPrimaryColor: '#1f2937',
    textSecondaryColor: '#6b7280',
    gainColor: '#16a34a',
    lossColor: '#dc2626',
  },
}

const DEFAULT_BACKGROUND_CSS = `html { background: linear-gradient(135deg, #101216 0%, #1d2128 100%); }`

function backgroundImageCss(url: string) {
  const safeUrl = String(url || '').trim().replace(/"/g, '%22')
  return `html { background-image: url("${safeUrl}"); background-size: cover; background-position: center; background-repeat: no-repeat; }`
}

function looksLikeUrl(value: string) {
  return /^(https?:\/\/|data:image\/|file:\/\/|\/)/i.test(String(value || '').trim())
}

function looksLikeCss(value: string) {
  const text = String(value || '').trim()
  if (!text) return false
  return /[{}]/.test(text) || /^(@|html\b|body\b|:root\b|\*\b)/i.test(text)
}

function looksLikeBase64Image(value: string) {
  const text = String(value || '').trim().replace(/\s+/g, '')
  return text.length >= 128 && /^[A-Za-z0-9+/=]+$/.test(text)
}

function toDataImageUrl(value: string, contentType = 'image/png') {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.startsWith('data:image/')) return text
  return `data:${contentType};base64,${text.replace(/\s+/g, '')}`
}

function pickStringField(value: any, keys: string[]) {
  if (!value || typeof value !== 'object') return ''

  for (const key of keys) {
    const direct = value[key]
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
  }

  for (const key of ['data', 'result', 'payload', 'body']) {
    const nested = value[key]
    if (!nested || typeof nested !== 'object') continue
    for (const candidate of keys) {
      const nestedValue = nested[candidate]
      if (typeof nestedValue === 'string' && nestedValue.trim()) return nestedValue.trim()
    }
  }

  return ''
}

async function resolveApiBackgroundCss(apiUrl: string, apiKey = '') {
  const headers = new Headers({
    'User-Agent': 'Koishi-ApexRankWatch/2.0.0',
    'Cache-Control': 'no-cache, no-store, max-age=0',
    Pragma: 'no-cache',
  })

  const token = apiKey.trim()
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('X-API-Key', token)
  }

  const response = await fetch(apiUrl, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const contentType = String(response.headers.get('content-type') || '').toLowerCase()

  if (contentType.includes('application/json')) {
    const payload = await response.json().catch(() => null)
    const cssText = pickStringField(payload, ['css', 'style', 'backgroundCss'])
    if (looksLikeCss(cssText)) return cssText

    const urlText = pickStringField(payload, ['url', 'image', 'imageUrl', 'backgroundUrl', 'backgroundImage'])
    if (looksLikeUrl(urlText)) return backgroundImageCss(urlText)

    const base64Text = pickStringField(payload, ['base64', 'imageBase64', 'backgroundBase64'])
    if (looksLikeBase64Image(base64Text)) {
      return backgroundImageCss(toDataImageUrl(base64Text, 'image/png'))
    }

    throw new Error('background api response json unsupported')
  }

  if (contentType.startsWith('image/')) {
    const arrayBuffer = await response.arrayBuffer()
    const dataUrl = `data:${contentType};base64,${Buffer.from(arrayBuffer).toString('base64')}`
    return backgroundImageCss(dataUrl)
  }

  const text = (await response.text()).trim()
  if (looksLikeCss(text)) return text
  if (looksLikeUrl(text)) return backgroundImageCss(text)
  if (looksLikeBase64Image(text)) return backgroundImageCss(toDataImageUrl(text, 'image/png'))

  throw new Error('background api response text unsupported')
}

export function resolveLeaderboardTheme(options: {
  themePreset: string
  backgroundType: 'preset' | 'css' | 'file' | 'url' | 'api'
  backgroundValue: string
  customCss: string
}) {
  const preset = PRESETS[options.themePreset] || PRESETS.default
  return {
    ...preset,
    backgroundType: options.backgroundType,
    backgroundValue: options.backgroundValue,
    customCss: options.customCss,
  } satisfies LeaderboardTemplateTheme
}

export async function buildLeaderboardBackgroundCss(params: {
  theme: LeaderboardTemplateTheme
  backgroundDir?: string
  apiKey?: string
}) {
  const { theme, backgroundDir, apiKey } = params
  if (theme.backgroundType === 'css' && theme.backgroundValue.trim()) {
    return theme.backgroundValue
  }
  if (theme.backgroundType === 'url' && theme.backgroundValue.trim()) {
    return backgroundImageCss(theme.backgroundValue)
  }
  if (theme.backgroundType === 'file' && theme.backgroundValue.trim() && backgroundDir) {
    const resolvedPath = await resolveLeaderboardBackgroundFile({
      rootDir: '',
      avatarDir: '',
      backgroundDir,
      fontDir: '',
      templateDir: '',
    }, theme.backgroundValue)
    if (resolvedPath) {
      return backgroundImageCss(`backgrounds/${basename(resolvedPath)}`)
    }
  }
  if (theme.backgroundType === 'api' && theme.backgroundValue.trim()) {
    try {
      return await resolveApiBackgroundCss(theme.backgroundValue, apiKey)
    } catch {
      return DEFAULT_BACKGROUND_CSS
    }
  }
  return DEFAULT_BACKGROUND_CSS
}
