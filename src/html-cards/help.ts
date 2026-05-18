import {
  getHelpContentSections,
  getHelpParameterRows,
  type HelpContentOptions,
  type HelpContentSection,
} from '../help-content'
import type {
  HtmlCardDocument,
  HtmlCardKeyValueBlock,
  HtmlCardMetaItem,
  HtmlCardSectionBlock,
} from './types'

type HelpRow = [string, string]

const HELP_CARD_META_ITEM_LIMIT = 4
const HELP_PARAMETER_SECTION_TITLE = '参数'

function isHelpParameterSection(section: HelpContentSection | undefined) {
  return section?.title === HELP_PARAMETER_SECTION_TITLE
}

function buildHelpCardMetaItems(commandSections: HelpContentSection[], parameterRows: HelpRow[]): HtmlCardMetaItem[] {
  const commandRowCount = commandSections.reduce((total, section) => total + section.rows.length, 0)

  return [
    { label: '命令分组', value: `${commandSections.length} 组` },
    { label: '命令条目', value: `${commandRowCount} 条` },
    { label: '参数说明', value: `${parameterRows.length} 项` },
  ].slice(0, HELP_CARD_META_ITEM_LIMIT)
}

function buildHelpSectionBlock(section: HelpContentSection): HtmlCardSectionBlock {
  return {
    type: 'section',
    title: section.title,
    items: section.rows.map(([title, description]) => ({
      title,
      description,
    })),
  }
}

function buildHelpParameterBlock(title: string, rows: HelpRow[]): HtmlCardKeyValueBlock {
  return {
    type: 'key-value',
    title,
    rows: rows.map(([label, value]) => ({
      label,
      value,
    })),
  }
}

export function buildHelpCardDocument(options: HelpContentOptions = {}): HtmlCardDocument {
  const sections = getHelpContentSections(options)
  const parameterSection = sections.find(isHelpParameterSection)
  const parameterRows = parameterSection?.rows?.length ? parameterSection.rows : getHelpParameterRows(options)
  const commandSections = sections.filter((section) => !isHelpParameterSection(section))
  const subtitle = commandSections.map((section) => section.title).join(' / ') || undefined
  const blocks: HtmlCardDocument['blocks'] = []
  let hasParameterBlock = false

  for (const section of sections) {
    if (isHelpParameterSection(section)) {
      blocks.push(buildHelpParameterBlock(section.title, parameterRows))
      hasParameterBlock = true
      continue
    }

    blocks.push(buildHelpSectionBlock(section))
  }

  if (!hasParameterBlock && parameterRows.length) {
    blocks.push(buildHelpParameterBlock(HELP_PARAMETER_SECTION_TITLE, parameterRows))
  }

  return {
    title: '帮助',
    subtitle,
    metaItems: buildHelpCardMetaItems(commandSections, parameterRows),
    blocks,
  }
}
