import RushDB from '@rushdb/javascript-sdk'

import { createHttpClient, type Transport } from './http'
import { LINK_TYPE, NOTE_LABEL, type NoteRecord } from './parse'
import type { RushDBSettings } from './settings'
import type { Store } from './sync'

const PAGE = 500
const DELETE_CHUNK = 1000

/** A note as the views show it. */
export interface NoteHit {
  id: string
  path: string
  title: string
  folder?: string
  score?: number
  excerpt?: string
}

export interface RelatedNotes {
  outgoing: NoteHit[]
  backlinks: NoteHit[]
  twoHops: NoteHit[]
  similar: NoteHit[]
  sharedTags: NoteHit[]
}

type Where = Record<string, unknown>

interface RecordLike {
  id: string
  data: Record<string, unknown>
  score?: number
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')

const toHit = (r: RecordLike): NoteHit => {
  const body = str(r.data.body)
  return {
    id: r.id,
    path: str(r.data.path),
    title: str(r.data.title) || str(r.data.path),
    folder: typeof r.data.folder === 'string' ? r.data.folder : undefined,
    score: r.score,
    excerpt: body ? body.replace(/\s+/g, ' ').slice(0, 160) : undefined
  }
}

export const createDb = (settings: RushDBSettings, transport?: Transport) => {
  const httpClient = createHttpClient(transport)
  if (settings.mode === 'engine') {
    return new RushDB(settings.engineToken, {
      direct: true,
      engineUrl: settings.engineUrl,
      ...(settings.engineScope && { scope: settings.engineScope }),
      httpClient
    })
  }
  return new RushDB(settings.apiKey, { url: settings.apiUrl, httpClient })
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

  async upsertNote(record: NoteRecord) {
    const result = await this.db.records.upsert({
      label: NOTE_LABEL,
      data: record,
      options: { mergeBy: ['vaultId', 'path'], mergeStrategy: 'rewrite', suggestTypes: true }
    })
    return result.id
  }

  async updateNote(id: string, data: Partial<NoteRecord>) {
    await this.db.records.update({ target: id, label: NOTE_LABEL, data })
  }

  async deleteNotes(ids: string[]) {
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      await this.db.records.deleteById(ids.slice(i, i + DELETE_CHUNK))
    }
  }

  async link(sourceId: string, targetIds: string[]) {
    if (!targetIds.length) return
    await this.db.records.attach({
      source: sourceId,
      target: targetIds,
      options: { type: LINK_TYPE, direction: 'out' }
    })
  }

  async unlink(sourceId: string, targetIds: string[]) {
    if (!targetIds.length) return
    await this.db.records.detach({
      source: sourceId,
      target: targetIds,
      options: { typeOrTypes: LINK_TYPE, direction: 'out' }
    })
  }

  async linkedFrom(sourceId: string) {
    const notes = await this.findAll({
      vaultId: this.vaultId,
      [NOTE_LABEL]: { $relation: { type: LINK_TYPE, direction: 'in' }, $id: sourceId }
    })
    return notes.map((n) => n.id)
  }

  async listNotes(vaultId: string) {
    const notes = await this.findAll({ vaultId })
    return notes.map((n) => ({
      id: n.id,
      path: str(n.data.path),
      contentHash: typeof n.data.contentHash === 'string' ? n.data.contentHash : undefined
    }))
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

  async related(note: { path: string; title: string; headings: string[]; text: string; tags: string[] }, limit = 10) {
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
    const [outgoing, backlinks, twoHops, similar, sharedTags] = await Promise.all([
      // Root notes the current note links to: the edge points into them.
      linked('in'),
      linked('out'),
      // Notes two links away in either direction.
      linked(undefined, { min: 2, max: 2 }),
      supportsEmbeddings(this.settings) ?
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
          .then((r) => r.data.map(toHit)),
      note.tags.length ? this.find({ ...notSelf, tags: { $in: note.tags } }, limit) : Promise.resolve([])
    ])

    const direct = new Set([...outgoing, ...backlinks].map((n) => n.path))
    return {
      outgoing,
      backlinks,
      twoHops: twoHops.filter((n) => !direct.has(n.path)),
      similar,
      sharedTags
    } satisfies RelatedNotes
  }

  private async find(where: Where, limit: number): Promise<NoteHit[]> {
    const result = await this.db.records.find({ labels: [NOTE_LABEL], where, limit } as never)
    return (result.data as RecordLike[]).map(toHit)
  }

  private async findAll(where: Where): Promise<RecordLike[]> {
    const all: RecordLike[] = []
    for (let skip = 0; ; skip += PAGE) {
      const page = await this.db.records.find({ labels: [NOTE_LABEL], where, limit: PAGE, skip } as never)
      all.push(...(page.data as RecordLike[]))
      if (page.data.length < PAGE) return all
    }
  }
}
