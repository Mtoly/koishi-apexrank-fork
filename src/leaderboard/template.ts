import type { LeaderboardHtmlRow, LeaderboardTemplateTheme } from './resource-types'

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderAvatar(row: LeaderboardHtmlRow) {
  if (row.avatarBase64) {
    return `<img class="avatar-image" src="data:image/png;base64,${row.avatarBase64}" alt="avatar" />`
  }
  return `<div class="avatar-fallback">${escapeHtml(row.displayName.slice(0, 1) || '?')}</div>`
}

function renderRow(row: LeaderboardHtmlRow) {
  return `<div class="leaderboard-row ${row.deltaDirection}">
    <div class="row-main">
      <div class="rank">#${row.rank}</div>
      <div class="avatar">${renderAvatar(row)}</div>
      <div class="identity">
        <div class="name" title="${escapeHtml(row.displayName)}">${escapeHtml(row.displayNameTruncated)}</div>
        <div class="meta">${escapeHtml(row.platformLabel)} ｜ 当前分 ${escapeHtml(row.latestScoreLabel)}</div>
      </div>
      <div class="delta">${escapeHtml(row.deltaLabel)}</div>
    </div>
    <div class="bar-track">
      <div class="bar-fill ${row.deltaDirection}" style="width: ${escapeHtml(row.barWidthCss)}"></div>
    </div>
  </div>`
}

export function buildLeaderboardHtml(params: {
  title: string
  periodRangeText: string
  periodLabel: string
  directionLabel: string
  rows: LeaderboardHtmlRow[]
  theme: LeaderboardTemplateTheme
  fontFacesCss: string
  backgroundCss: string
  resourceBaseHref: string
  titleFont: string
  bodyFont: string
  numberFont: string
}) {
  const {
    title,
    periodRangeText,
    periodLabel,
    directionLabel,
    rows,
    theme,
    fontFacesCss,
    backgroundCss,
    resourceBaseHref,
    titleFont,
    bodyFont,
    numberFont,
  } = params

  const rowsHtml = rows.map(renderRow).join('\n')

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
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 28px;
  font-family: '${bodyFont}', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif;
  color: var(--text-primary);
}
.card {
  width: 100%;
  max-width: 100%;
  background: rgba(10, 12, 16, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
}
.header {
  padding: 24px 28px 14px 28px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.title {
  margin: 0;
  font-size: 34px;
  line-height: 1.25;
  font-family: '${titleFont}', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif;
}
.subtitle {
  margin-top: 10px;
  color: var(--text-secondary);
  font-size: 15px;
}
.summary {
  display: flex;
  gap: 12px;
  padding: 16px 28px 10px 28px;
  flex-wrap: wrap;
}
.summary-item {
  background: rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  padding: 10px 14px;
  min-width: 120px;
}
.summary-label {
  color: var(--text-secondary);
  font-size: 13px;
}
.summary-value {
  margin-top: 4px;
  font-size: 18px;
  font-family: '${numberFont}', '${bodyFont}', 'Noto Sans CJK SC', sans-serif;
}
.rows {
  padding: 10px 22px 22px 22px;
}
.leaderboard-row {
  padding: 14px 10px 16px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.leaderboard-row:last-child { border-bottom: none; }
.row-main {
  display: grid;
  grid-template-columns: 72px 56px minmax(260px, 1fr) 140px;
  align-items: center;
  gap: 12px;
}
.rank,
.delta {
  font-family: '${numberFont}', '${bodyFont}', 'Noto Sans CJK SC', sans-serif;
}
.rank {
  font-size: 20px;
  color: var(--text-secondary);
}
.avatar {
  width: 48px;
  height: 48px;
}
.avatar-image,
.avatar-fallback {
  width: 48px;
  height: 48px;
  border-radius: 50%;
}
.avatar-image { display: block; }
.avatar-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
  font-size: 20px;
}
.identity {
  min-width: 0;
}
.name {
  font-size: 22px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 14px;
}
.delta {
  justify-self: end;
  font-size: 24px;
  font-weight: 700;
}
.bar-track {
  margin-top: 12px;
  width: 100%;
  height: 16px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.10);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.2s ease;
}
.bar-fill.gain { background: var(--gain); }
.bar-fill.loss { background: var(--loss); }
.leaderboard-row.gain .delta { color: var(--gain); }
.leaderboard-row.loss .delta { color: var(--loss); }
.footer {
  padding: 0 28px 20px 28px;
  color: var(--text-secondary);
  font-size: 13px;
}
${theme.customCss || ''}
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1 class="title">${escapeHtml(title)}</h1>
      <div class="subtitle">${escapeHtml(periodRangeText)}</div>
    </div>
    <div class="summary">
      <div class="summary-item"><div class="summary-label">统计周期</div><div class="summary-value">${escapeHtml(periodLabel)}榜</div></div>
      <div class="summary-item"><div class="summary-label">榜单类型</div><div class="summary-value">${escapeHtml(directionLabel)}榜</div></div>
      <div class="summary-item"><div class="summary-label">上榜人数</div><div class="summary-value">${rows.length}</div></div>
    </div>
    <div class="rows">
      ${rowsHtml}
    </div>
    <div class="footer">统计范围与时间均按北京时间计算</div>
  </div>
</body>
</html>`
}
