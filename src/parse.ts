export const NOTE_LABEL = 'NOTE'
export const LINK_TYPE = 'LINKS_TO'

/** The parts of Obsidian's `CachedMetadata` the parser reads. */
export interface NoteMetadata {
  frontmatter?: Record<string, unknown>
  headings?: Array<{ heading: string; level: number }>
  tags?: Array<{ tag: string }>
}

export interface NoteInput {
  vaultId: string
  path: string
  basename: string
  mtime: number
  text: string
  metadata: NoteMetadata | null
  maxBodyChars: number
  /** Indexed notes this note links to (see `outgoingLinks`). */
  links: string[]
}

type Scalar = string | number | boolean
type PropertyValue = Scalar | Scalar[]

/** A note as a flat RushDB record: the SDK's upsert takes flat objects only. */
export type NoteRecord = Record<string, PropertyValue>

const FRONTMATTER_RESERVED = new Set(['position'])

/** `Due date` → `fm_due_date`; keeps record keys predictable for queries. */
export const frontmatterKey = (key: string) =>
  'fm_' +
  key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')

const isScalar = (v: unknown): v is Scalar =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean'

/** Scalars and arrays of scalars; nested objects and empty values are skipped. */
const toPropertyValue = (v: unknown): PropertyValue | undefined => {
  if (isScalar(v)) return v === '' ? undefined : v
  if (Array.isArray(v)) {
    const items = v.filter(isScalar)
    if (items.length === 0) return undefined
    // Mixed arrays become strings so the property keeps a single type.
    return items.every((i) => typeof i === typeof items[0]) ? items : items.map(String)
  }
  return undefined
}

const normalizeTag = (tag: string) => tag.replace(/^#/, '').trim()

/** Tags from the body (`#tag`) and from the `tags` property, deduplicated. */
export const collectTags = (metadata: NoteMetadata | null): string[] => {
  const tags = new Set<string>()
  for (const t of metadata?.tags ?? []) tags.add(normalizeTag(t.tag))
  const fm = metadata?.frontmatter?.tags ?? metadata?.frontmatter?.tag
  const fmTags = Array.isArray(fm) ? fm : typeof fm === 'string' ? fm.split(/[,\s]+/) : []
  for (const t of fmTags) if (typeof t === 'string' && normalizeTag(t)) tags.add(normalizeTag(t))
  return [...tags].filter(Boolean).sort()
}

const collectAliases = (metadata: NoteMetadata | null): string[] => {
  const raw = metadata?.frontmatter?.aliases ?? metadata?.frontmatter?.alias
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return list.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim())
}

/** The note text without its YAML frontmatter block. */
export const stripFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')

export const toNoteRecord = (input: NoteInput, hash: string): NoteRecord => {
  const { metadata } = input
  const record: NoteRecord = {
    vaultId: input.vaultId,
    path: input.path,
    title: input.basename,
    folder: input.path.includes('/') ? input.path.slice(0, input.path.lastIndexOf('/')) : '',
    modifiedAt: new Date(input.mtime).toISOString(),
    contentHash: hash
  }

  const body = stripFrontmatter(input.text).trim().slice(0, input.maxBodyChars)
  if (body) record.body = body

  const tags = collectTags(metadata)
  if (tags.length) record.tags = tags

  const aliases = collectAliases(metadata)
  if (aliases.length) record.aliases = aliases

  // RushDB joins `linksTo` to the targets' `linkKey` to create the LINKS_TO relationships.
  // Both carry the vault id, so the join can never connect notes of different vaults.
  record.linkKey = linkKey(input.vaultId, input.path)
  if (input.links.length) record.linksTo = input.links.map((p) => linkKey(input.vaultId, p))

  const headings = (metadata?.headings ?? []).map((h) => h.heading.trim()).filter(Boolean)
  if (headings.length) record.headings = headings

  for (const [key, value] of Object.entries(metadata?.frontmatter ?? {})) {
    if (FRONTMATTER_RESERVED.has(key)) continue
    const name = frontmatterKey(key)
    const v = toPropertyValue(value)
    if (name !== 'fm_' && v !== undefined) record[name] = v
  }

  return record
}

/** A note's key for links: unique across vaults sharing a project. */
export const linkKey = (vaultId: string, path: string) => `${vaultId}:${path}`

/** Bumped when the record format changes, so every note is re-sent once in the new format. */
const RECORD_FORMAT = 2

/** SHA-256 of what is sent for the note, so an unchanged note is never re-sent. */
export const hashNote = async (input: NoteInput): Promise<string> => {
  const data = new TextEncoder().encode(
    `${RECORD_FORMAT}\u0000${input.maxBodyChars}\u0000${input.links.join('\u0001')}\u0000${input.text}`
  )
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Paths this note links to, from Obsidian's resolved links; only notes inside the index count. */
export const outgoingLinks = (
  path: string,
  resolvedLinks: Record<string, Record<string, number>>,
  isIndexed: (path: string) => boolean
): string[] =>
  Object.keys(resolvedLinks[path] ?? {})
    .filter((target) => target !== path && target.endsWith('.md') && isIndexed(target))
    .sort()
