import type { LeaderboardTemplateTheme } from '../leaderboard/resource-types'
import type {
  HtmlCardBlock,
  HtmlCardDocument,
  HtmlCardKeyValueBlock,
  HtmlCardListBlock,
  HtmlCardMetaItem,
  HtmlCardSectionBlock,
  HtmlCardTableBlock,
  HtmlCardTipBlock,
} from './types'

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function requireNonEmptyText(value: string, fieldName: string) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`html card field "${fieldName}" must not be empty`)
  return text
}

function wrapHtmlCardSection(params: {
  title?: string
  description?: string
  contentHtml: string
}) {
  const { title, description, contentHtml } = params
  const titleHtml = title ? `<div class="html-card-section-title">${escapeHtml(title)}</div>` : ''
  const descriptionHtml = description ? `<div class="html-card-section-description">${escapeHtml(description)}</div>` : ''
  return `<section class="html-card-section">${titleHtml}${descriptionHtml}<div class="html-card-section-body">${contentHtml}</div></section>`
}

function renderHtmlCardMetaItems(items: HtmlCardMetaItem[]) {
  if (!items.length) return ''
  return `<div class="html-card-meta-grid">${items.map((item, index) => `<div class="html-card-meta-item"><div class="html-card-meta-label">${escapeHtml(requireNonEmptyText(item.label, `metaItems[${index}].label`))}</div><div class="html-card-meta-value">${escapeHtml(requireNonEmptyText(item.value, `metaItems[${index}].value`))}</div></div>`).join('')}</div>`
}

function renderSectionBlock(block: HtmlCardSectionBlock) {
  const title = requireNonEmptyText(block.title, 'section.title')
  const rows = (block.items || [])
    .map((item, index) => {
      const itemTitle = requireNonEmptyText(item.title, `section.items[${index}].title`)
      return `<div class="html-card-item"><div class="html-card-item-title">${escapeHtml(itemTitle)}</div>${item.description ? `<div class="html-card-item-description">${escapeHtml(item.description)}</div>` : ''}</div>`
    })
    .join('')

  return wrapHtmlCardSection({
    title,
    description: block.description,
    contentHtml: rows,
  })
}

function renderKeyValueBlock(block: HtmlCardKeyValueBlock) {
  const rows = block.rows
    .map((row, index) => `<div class="html-card-kv-row"><div class="html-card-kv-label">${escapeHtml(requireNonEmptyText(row.label, `key-value.rows[${index}].label`))}</div><div class="html-card-kv-value">${escapeHtml(requireNonEmptyText(row.value, `key-value.rows[${index}].value`))}</div></div>`)
    .join('')

  return wrapHtmlCardSection({
    title: block.title,
    contentHtml: `<div class="html-card-kv-list">${rows}</div>`,
  })
}

function renderListBlock(block: HtmlCardListBlock) {
  const items = block.items
    .map((item, index) => {
      if (typeof item === 'string') {
        return `<li class="html-card-list-simple">${escapeHtml(requireNonEmptyText(item, `list.items[${index}]`))}</li>`
      }
      const itemTitle = requireNonEmptyText(item.title, `list.items[${index}].title`)
      return `<li class="html-card-list-rich"><div class="html-card-item-title">${escapeHtml(itemTitle)}</div>${item.description ? `<div class="html-card-item-description">${escapeHtml(item.description)}</div>` : ''}</li>`
    })
    .join('')

  return wrapHtmlCardSection({
    title: block.title,
    contentHtml: `<ul class="html-card-list">${items}</ul>`,
  })
}

function renderTableBlock(block: HtmlCardTableBlock) {
  const columns = block.columns.map((column, index) => requireNonEmptyText(column, `table.columns[${index}]`))
  const rows = block.rows
    .map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== columns.length) {
        throw new Error(`html card table row ${rowIndex} column count mismatch`)
      }
      return `<tr>${row.map((cell, cellIndex) => `<td>${escapeHtml(requireNonEmptyText(cell, `table.rows[${rowIndex}][${cellIndex}]`))}</td>`).join('')}</tr>`
    })
    .join('')

  return wrapHtmlCardSection({
    title: block.title,
    contentHtml: `<div class="html-card-table-wrap"><table class="html-card-table"><thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`,
  })
}

function renderTipBlock(block: HtmlCardTipBlock) {
  const variant = block.variant || 'info'
  const titleHtml = block.title ? `<div class="html-card-tip-title">${escapeHtml(block.title)}</div>` : ''
  const content = requireNonEmptyText(block.content, 'tip.content')
  return `<section class="html-card-tip html-card-tip-${escapeHtml(variant)}">${titleHtml}<div class="html-card-tip-content">${escapeHtml(content)}</div></section>`
}

export function renderHtmlCardBlock(block: HtmlCardBlock) {
  if (block.type === 'section') return renderSectionBlock(block)
  if (block.type === 'key-value') return renderKeyValueBlock(block)
  if (block.type === 'list') return renderListBlock(block)
  if (block.type === 'table') return renderTableBlock(block)
  return renderTipBlock(block)
}

export function renderHtmlCardBlocks(blocks: HtmlCardBlock[]) {
  return blocks.map((block) => renderHtmlCardBlock(block)).join('')
}

export function buildHtmlCardDocumentHtml(params: {
  document: HtmlCardDocument
  theme: LeaderboardTemplateTheme
  fontFacesCss: string
  backgroundCss: string
  resourceBaseHref: string
  titleFont: string
  bodyFont: string
  numberFont: string
  customCss?: string
}) {
  const {
    document,
    theme,
    fontFacesCss,
    backgroundCss,
    resourceBaseHref,
    titleFont,
    bodyFont,
    numberFont,
    customCss,
  } = params

  const title = escapeHtml(requireNonEmptyText(document.title, 'document.title'))
  const subtitle = document.subtitle ? escapeHtml(document.subtitle) : ''
  const metaHtml = renderHtmlCardMetaItems(document.metaItems || [])
  const blockHtml = renderHtmlCardBlocks(document.blocks)
  const footer = document.footer ? escapeHtml(document.footer) : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<base href="${escapeHtml(resourceBaseHref)}" />
<style>
${fontFacesCss}
${backgroundCss}
:root {
  --accent: ${theme.accentColor};
  --surface: ${theme.surfaceColor};
  --text-primary: ${theme.textPrimaryColor};
  --text-secondary: ${theme.textSecondaryColor};
  --gain: ${theme.gainColor};
  --loss: ${theme.lossColor};
  --surface-strong: color-mix(in srgb, var(--surface) 92%, #000 8%);
  --surface-soft: color-mix(in srgb, var(--surface) 80%, #fff 20%);
  --surface-muted: color-mix(in srgb, var(--surface) 86%, #fff 14%);
  --border-soft: color-mix(in srgb, var(--text-primary) 10%, transparent);
  --border-strong: color-mix(in srgb, var(--accent) 55%, transparent);
  --tip-info: color-mix(in srgb, var(--accent) 18%, transparent);
  --tip-warn: rgba(255, 178, 66, 0.12);
  --tip-success: rgba(74, 222, 128, 0.12);
}
* { box-sizing: border-box; }
html, body {
  min-height: 100%;
}
body {
  margin: 0;
  padding: 28px;
  font-family: '${bodyFont}', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif;
  color: var(--text-primary);
}
.html-card-shell {
  width: 100%;
  max-width: 100%;
  background: color-mix(in srgb, var(--surface-strong) 88%, rgba(10, 12, 16, 0.84) 12%);
  border: 1px solid var(--border-soft);
  border-radius: 18px;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
}
.html-card-header {
  padding: 24px 28px 16px 28px;
  border-bottom: 1px solid var(--border-soft);
}
.html-card-title {
  margin: 0;
  font-size: 34px;
  line-height: 1.25;
  font-family: '${titleFont}', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif;
}
.html-card-subtitle {
  margin-top: 10px;
  color: var(--text-secondary);
  font-size: 15px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.html-card-body {
  padding: 18px 22px 22px 22px;
}
.html-card-meta-grid {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}
.html-card-meta-item {
  min-width: 120px;
  background: color-mix(in srgb, var(--surface-muted) 88%, transparent);
  border-radius: 10px;
  padding: 10px 14px;
}
.html-card-meta-label {
  color: var(--text-secondary);
  font-size: 13px;
}
.html-card-meta-value {
  margin-top: 4px;
  font-size: 18px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: '${numberFont}', '${bodyFont}', 'Noto Sans CJK SC', sans-serif;
}
.html-card-section {
  margin-bottom: 14px;
  padding: 14px 16px 16px 16px;
  background: color-mix(in srgb, var(--surface-soft) 88%, transparent);
  border: 1px solid var(--border-soft);
  border-radius: 12px;
}
.html-card-section:last-child {
  margin-bottom: 0;
}
.html-card-section-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 12px;
}
.html-card-section-description {
  color: var(--text-secondary);
  font-size: 14px;
  margin-bottom: 10px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.html-card-section-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.html-card-item + .html-card-item {
  margin-top: 10px;
}
.html-card-item-title {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.html-card-item-description {
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.html-card-kv-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.html-card-kv-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-muted) 88%, transparent);
}
.html-card-kv-label {
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.html-card-kv-value {
  font-size: 15px;
  line-height: 1.5;
  text-align: right;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: '${numberFont}', '${bodyFont}', 'Noto Sans CJK SC', sans-serif;
}
.html-card-list {
  margin: 0;
  padding-left: 22px;
}
.html-card-list-simple,
.html-card-list-rich {
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.html-card-list-rich + .html-card-list-rich,
.html-card-list-simple + .html-card-list-simple {
  margin-top: 8px;
}
.html-card-table-wrap {
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--border-soft);
}
.html-card-table {
  width: 100%;
  border-collapse: collapse;
}
.html-card-table th,
.html-card-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border-soft);
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.html-card-table th {
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--surface-muted) 88%, transparent);
}
.html-card-table tbody tr:last-child td {
  border-bottom: none;
}
.html-card-tip {
  margin-top: 14px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--border-soft);
}
.html-card-tip-title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.html-card-tip-content {
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.html-card-tip-info {
  background: var(--tip-info);
}
.html-card-tip-warn {
  background: var(--tip-warn);
}
.html-card-tip-success {
  background: var(--tip-success);
}
.html-card-footer {
  padding: 0 28px 20px 28px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
${customCss || ''}
</style>
</head>
<body>
  <div class="html-card-shell">
    <div class="html-card-header">
      <h1 class="html-card-title">${title}</h1>
      ${subtitle ? `<div class="html-card-subtitle">${subtitle}</div>` : ''}
    </div>
    <div class="html-card-body">
      ${metaHtml}
      ${blockHtml}
    </div>
    ${footer ? `<div class="html-card-footer">${footer}</div>` : ''}
  </div>
</body>
</html>`
}
