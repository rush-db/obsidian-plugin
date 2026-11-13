import RushDB from '@rushdb/javascript-sdk'

import { createHttpClient, type Transport } from './http'
import { LINK_TYPE, NOTE_LABEL, type NoteRecord } from './parse'
import type { Credentials, RushDBSettings } from './settings'
import type { Store } from './sync'

const PAGE = 500
/** Set on every LINKS_TO relationship the plugin writes. */
export const LINK_PROPERTIES = { kind: 'wikilink' }
const DELETE_CHUNK = 1000

/** A note as the views show it. */
export interface NoteHit {
  id: string
  path: string
  title: string
  folder?: string
  /** Similarity to the query (vector search: cosine, 0–1) or its relevance (keyword search). */
  score?: number
  excerpt?: string
  tags?: string[]
  /** The current note's tags this note also has (shared-tag hits), in the current note's order. */
  matchedTags?: string[]
}

export interface RelatedNotes {
  outgoing: NoteHit[]
  backlinks: NoteHit[]
  twoHops: NoteHit[]
  similar: NoteHit[]
  sharedTags: NoteHit[]
}

export const RELATED_SECTIONS = ['outgoing', 'backlinks', 'twoHops', 'similar', 'sharedTags'] as const

/** What the related-notes queries need to know about the current note. */
export interface RelatedQuery {
  path: string
  title: string
  headings: string[]
  text: string
  tags: string[]
}

type Where = Record<string, unknown>

interface NoteSummary {
  id: string
  path: string
  contentHash?: string
}

/** A selected `__id` comes back as 32 hex digits; record ids elsewhere are dashed UUIDs. */
export const toRecordId = (raw: string) =>
  /^[0-9a-f]{32}$/i.test(raw) ?
    `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
  : raw

interface RecordLike {
  id: string
  data: Record<string, unknown>
  score?: number
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')

export const toHit = (r: RecordLike): NoteHit => {
  const body = str(r.data.body)
  // Search results carry their score in the record's data (`__score`).
  const score = r.score ?? r.data.__score
  return {
    id: r.id,
    path: str(r.data.path),
    title: str(r.data.title) || str(r.data.path),
    folder: typeof r.data.folder === 'string' ? r.data.folder : undefined,
    score: typeof score === 'number' ? score : undefined,
    excerpt: body ? body.replace(/\s+/g, ' ').slice(0, 160) : undefined,
    tags: Array.isArray(r.data.tags) ? r.data.tags.filter((t): t is string => typeof t === 'string') : undefined
  }
}

/** Candidates read for shared tags, so the notes with the most tags in common can be kept. */
const SHARED_TAG_POOL = 5

/** Notes sharing the most tags with the current one first; ties keep the server's order. */
export const rankBySharedTags = (hits: NoteHit[], tags: string[], limit: number): NoteHit[] =>
  hits
    .map((hit) => ({ ...hit, matchedTags: tags.filter((tag) => hit.tags?.includes(tag)) }))
    .filter((hit) => hit.matchedTags.length > 0)
    .map((hit, order) => ({ hit, order }))
    .sort((a, b) => b.hit.matchedTags.length - a.hit.matchedTags.length || a.order - b.order)
    .slice(0, limit)
    .map(({ hit }) => hit)

export const createDb = (settings: RushDBSettings, credentials: Credentials, transport?: Transport) => {
  const httpClient = createHttpClient(transport)
  if (settings.mode === 'engine') {
    return new RushDB(credentials.engineToken, {
      direct: true,
      engineUrl: settings.engineUrl,
      ...(settings.engineScope && { scope: settings.engineScope }),
      httpClient
    })
  }
  return new RushDB(credentials.apiKey, { url: settings.apiUrl, httpClient })
}

type Db = ReturnType<typeof createDb>

/** Managed embeddings need RushDB Cloud (or a platform with an embedding model). */
export const supportsEmbeddings = (settings: RushDBSettings) => settings.mode === 'api' && settings.embeddings

export class RushDBVault implements Store {
  constructor(
    private readonly db: Db,
    private readonly vaultId: string,
    private readonly settings: RushDBSettings
  ) {}

  // Sync

  async upsertNotes(records: NoteRecord[]) {
    const result = await this.db.records.createMany({
      label: NOTE_LABEL,
      data: records,
      options: { mergeBy: ['vaultId', 'path'], mergeStrategy: 'rewrite', suggestTypes: true, returnResult: true }
    })
    const ids: Record<string, string> = {}
    for (const r of result.data) ids[str(r.data.path)] = r.id
    return ids
  }

  async updateNote(id: string, data: Partial<NoteRecord>) {
    await this.db.records.update({ target: id, label: NOTE_LABEL, data })
  }

  async deleteNotes(ids: string[]) {
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      await this.db.records.deleteById(ids.slice(i, i + DELETE_CHUNK))
    }
  }

  async linkNotes(paths: string[]) {
    if (!paths.length) return
    await this.db.relationships.createMany({
      source: { label: NOTE_LABEL, key: 'linksTo', where: { vaultId: this.vaultId, path: { $in: paths } } },
      target: { label: NOTE_LABEL, key: 'linkKey', where: { vaultId: this.vaultId } },
      type: LINK_TYPE,
      direction: 'out',
      // Edge properties also keep the platform from saving this call as a reusable join pattern.
      properties: LINK_PROPERTIES
    })
  }

  async unlinkNotes(paths: string[]) {
    if (!paths.length) return
    await this.db.relationships.deleteMany({
      source: { label: NOTE_LABEL, where: { vaultId: this.vaultId, path: { $in: paths } } },
      target: { label: NOTE_LABEL, where: { vaultId: this.vaultId } },
      type: LINK_TYPE,
      direction: 'out',
      manyToMany: true
    })
  }

  /** Ids of the notes `sourceId` links to. */
  async linkedFrom(sourceId: string) {
    const notes = await this.listWhere({
      vaultId: this.vaultId,
      [NOTE_LABEL]: { $relation: { type: LINK_TYPE, direction: 'in' }, $id: sourceId }
    })
    return notes.map((n) => n.id)
  }

  async listNotes(vaultId: string) {
    return this.listWhere({ vaultId })
  }

  /** Removes every note of this vault, with its links. */
  async purgeVault() {
    const notes = await this.listNotes(this.vaultId)
    await this.deleteNotes(notes.map((n) => n.id))
    return notes.length
  }

  // Indexes

  /** Creates the BM25 index over notes and, when enabled, the managed embedding index on `body`. */
  async ensureIndexes() {
    const text = await this.db.textIndexes.find()
    if (!(text.data ?? []).some((i) => i.label === NOTE_LABEL)) {
      await this.db.textIndexes.create({ label: NOTE_LABEL, property: '*' })
    }
    if (supportsEmbeddings(this.settings)) {
      const vectors = await this.db.ai.indexes.find()
      if (!(vectors.data ?? []).some((i) => i.label === NOTE_LABEL && i.propertyName === 'body')) {
        await this.db.ai.indexes.create({ label: NOTE_LABEL, propertyName: 'body' })
      }
    }
  }

  // Queries for the views

  async search(query: string, limit = 20): Promise<NoteHit[]> {
    const where = { vaultId: this.vaultId }
    if (supportsEmbeddings(this.settings)) {
      // Hybrid: semantic and keyword rankings over the same notes, fused.
      const result = await this.db.records.vectorSearch({
        labels: [NOTE_LABEL],
        propertyName: 'body',
        query,
        where,
        limit,
        text: { query }
      })
      return result.data.map(toHit)
    }
    const result = await this.db.records.textSearch({ query, labels: [NOTE_LABEL], where, limit })
    return result.data.map(toHit)
  }

  async related(note: RelatedQuery, limit = 10): Promise<RelatedNotes> {
    const [outgoing, backlinks, twoHops, similar, sharedTags] = await Promise.all(
      RELATED_SECTIONS.map((section) => this.relatedSection(section, note, limit))
    )
    return { outgoing, backlinks, twoHops, similar, sharedTags }
  }

  /** One kind of related notes, so a view can reload a single section. */
  async relatedSection(section: keyof RelatedNotes, note: RelatedQuery, limit = 10): Promise<NoteHit[]> {
    const self = { vaultId: this.vaultId, path: note.path }
    const notSelf = { vaultId: this.vaultId, path: { $ne: note.path } }
    const linked = (direction?: 'in' | 'out', hops?: { min: number; max: number }) =>
      this.find(
        {
          ...notSelf,
          [NOTE_LABEL]: { $relation: { type: LINK_TYPE, ...(direction && { direction }), ...(hops && { hops }) }, ...self }
        },
        limit
      )
    const similarQuery = [note.title, ...note.headings].join(' ')

    switch (section) {
      // Root notes the current note links to: the edge points into them.
      case 'outgoing':
        return linked('in')
      case 'backlinks':
        return linked('out')
      // Notes two links away in either direction, without the ones linked directly.
      case 'twoHops': {
        const [twoHops, outgoing, backlinks] = await Promise.all([
          linked(undefined, { min: 2, max: 2 }),
          linked('in'),
          linked('out')
        ])
        const direct = new Set([...outgoing, ...backlinks].map((n) => n.path))
        return twoHops.filter((n) => !direct.has(n.path))
      }
      case 'similar':
        return supportsEmbeddings(this.settings) ?
            this.db.records
              .vectorSearch({
                labels: [NOTE_LABEL],
                propertyName: 'body',
                query: `${similarQuery}\n${note.text.slice(0, 2000)}`,
                where: notSelf,
                limit
              })
              .then((r) => r.data.map(toHit))
          : this.db.records
              .textSearch({ query: similarQuery, labels: [NOTE_LABEL], where: notSelf, limit })
              .then((r) => r.data.map(toHit))
      case 'sharedTags':
        return note.tags.length ?
            this.find({ ...notSelf, tags: { $in: note.tags } }, limit * SHARED_TAG_POOL).then((hits) =>
              rankBySharedTags(hits, note.tags, limit)
            )
          : []
    }
  }

  private async find(where: Where, limit: number): Promise<NoteHit[]> {
    const result = await this.db.records.find({ labels: [NOTE_LABEL], where, limit } as never)
    return (result.data as RecordLike[]).map(toHit)
  }

  /**
   * Id, path and content hash of the matching notes, page by page. Selects just
   * those fields, so listing a large vault does not download every note's text.
   */
  private async listWhere(where: Where): Promise<NoteSummary[]> {
    const all: NoteSummary[] = []
    for (let skip = 0; ; skip += PAGE) {
      const page = await this.db.records.find({
        labels: [NOTE_LABEL],
        where,
        select: { path: '$record.path', contentHash: '$record.contentHash', recordId: '$record.__id' },
        limit: PAGE,
        skip
      } as never)
      for (const { data } of page.data as Array<{ data: Record<string, unknown> }>) {
        const contentHash = str(data.contentHash)
        all.push({ id: toRecordId(str(data.recordId)), path: str(data.path), ...(contentHash && { contentHash }) })
      }
      if (page.data.length < PAGE) return all
    }
  }
}
