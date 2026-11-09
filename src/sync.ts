import { hashNote, linkKey, outgoingLinks, toNoteRecord, type NoteMetadata, type NoteRecord } from './parse'
import { isIncluded, type NoteState, type RushDBSettings, type SyncState } from './settings'

/** The RushDB operations sync needs; `client.ts` implements it over the SDK. */
export interface Store {
  /**
   * Creates or updates the notes matched by `vaultId` + `path`, in one request;
   * resolves to each note's record id by path.
   */
  upsertNotes: (records: NoteRecord[]) => Promise<Record<string, string>>
  updateNote: (id: string, data: Partial<NoteRecord>) => Promise<void>
  deleteNotes: (ids: string[]) => Promise<void>
  /**
   * Creates the LINKS_TO relationships from these notes to every note of the vault
   * whose `linkKey` is in their `linksTo`, in one request. Existing ones are kept.
   */
  linkNotes: (paths: string[]) => Promise<void>
  /** Removes every LINKS_TO relationship going out of these notes, in one request. */
  unlinkNotes: (paths: string[]) => Promise<void>
  /** Every note of this vault: id, path and content hash. */
  listNotes: (vaultId: string) => Promise<Array<{ id: string; path: string; contentHash?: string }>>
}

/** The vault operations sync needs; `main.ts` implements it over Obsidian's API. */
export interface VaultSource {
  /** Markdown files in the folders chosen for indexing; nothing outside them is listed. */
  indexedFiles: () => Array<{ path: string; basename: string; mtime: number }>
  file: (path: string) => { path: string; basename: string; mtime: number } | null
  read: (path: string) => Promise<string>
  metadata: (path: string) => NoteMetadata | null
  resolvedLinks: () => Record<string, Record<string, number>>
}

export interface SyncProgress {
  phase: 'notes' | 'links'
  done: number
  total: number
}

type Pending = { kind: 'upsert'; path: string } | { kind: 'delete'; path: string }

type ResolvedLinks = Record<string, Record<string, number>>

/** Notes read and hashed together; their changed ones go out in batches. */
const READ_CHUNK = 100
/** Notes per upsert request, and the request size that closes a batch early. */
export const BATCH_NOTES = 100
export const BATCH_BYTES = 1_000_000
/** Source notes per link or unlink request (their paths go in its filter). */
export const LINK_BATCH = 500

const RETRIES = 5

/** Retries with exponential backoff (0.5 s to 8 s), which also rides out rate limits. */
const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  let lastError: unknown
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < RETRIES - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, Math.min(500 * 2 ** attempt, 8000)))
      }
    }
  }
  throw lastError
}

/** Splits records into batches by count and by serialized size. */
export const toBatches = (records: NoteRecord[], maxNotes = BATCH_NOTES, maxBytes = BATCH_BYTES) => {
  const batches: NoteRecord[][] = []
  let current: NoteRecord[] = []
  let bytes = 0
  for (const record of records) {
    const size = JSON.stringify(record).length
    if (current.length && (current.length >= maxNotes || bytes + size > maxBytes)) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(record)
    bytes += size
  }
  if (current.length) batches.push(current)
  return batches
}

const chunks = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Keeps a vault's notes and links mirrored in RushDB. Markdown stays the source
 * of truth: sync only writes to RushDB, never to the vault.
 *
 * Each note carries `linksTo`, the keys of the indexed notes it links to; RushDB
 * turns it into LINKS_TO relationships by joining it to their `linkKey`, a batch
 * of notes per request.
 */
export class SyncEngine {
  private queue = new Map<string, Pending>()
  private running: Promise<void> | null = null

  constructor(
    private readonly vault: VaultSource,
    private readonly store: Store,
    private readonly settings: () => RushDBSettings,
    private readonly state: SyncState,
    private readonly persist: () => Promise<void>,
    private readonly onProgress: (progress: SyncProgress | null) => void = () => {}
  ) {}

  get pending() {
    return this.queue.size
  }

  isIndexed = (path: string) => path.endsWith('.md') && isIncluded(path, this.settings())

  enqueue(path: string) {
    if (path.endsWith('.md')) this.queue.set(path, { kind: 'upsert', path })
  }

  enqueueDelete(path: string) {
    if (this.state.notes[path]) this.queue.set(path, { kind: 'delete', path })
    else this.queue.delete(path)
  }

  /** A rename keeps the record (and its links); only its path and title change. */
  async rename(oldPath: string, newPath: string) {
    const known = this.state.notes[oldPath]
    this.queue.delete(oldPath)
    if (!known) {
      this.enqueue(newPath)
      return this.flush()
    }
    if (!this.isIndexed(newPath)) {
      this.enqueueDelete(oldPath)
      return this.flush()
    }
    await this.serialize(async () => {
      const file = this.vault.file(newPath)
      const title = file?.basename ?? newPath.replace(/^.*\//, '').replace(/\.md$/, '')
      const folder = newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : ''
      await withRetry(() =>
        this.store.updateNote(known.id, { path: newPath, title, folder, linkKey: linkKey(this.state.vaultId, newPath) })
      )
      delete this.state.notes[oldPath]
      this.state.notes[newPath] = known
      await this.persist()
    })
    // Notes linking here still list the old path in `linksTo`; resend them.
    for (const [path, note] of Object.entries(this.state.notes)) {
      if (note.links.includes(oldPath)) this.enqueue(path)
    }
    await this.flush()
  }

  /** Applies queued changes; concurrent calls share one run. */
  flush(): Promise<void> {
    return this.serialize(async () => {
      while (this.queue.size > 0) {
        const batch = [...this.queue.values()]
        this.queue.clear()
        await this.apply(batch)
      }
    })
  }

  /**
   * Brings RushDB in line with the vault after changes made while the plugin was
   * off, or after the indexed folders changed: removes notes no longer in the
   * index, adopts records already there and queues everything that differs.
   */
  async reconcile() {
    await this.serialize(async () => {
      const remote = await withRetry(() => this.store.listNotes(this.state.vaultId))
      const local = new Set(this.vault.indexedFiles().map((f) => f.path).filter(this.isIndexed))

      const stale = remote.filter((r) => !local.has(r.path))
      if (stale.length) {
        await withRetry(() => this.store.deleteNotes(stale.map((r) => r.id)))
      }

      const known: Record<string, NoteState> = {}
      for (const r of remote) {
        if (!local.has(r.path)) continue
        const previous = this.state.notes[r.path]
        known[r.path] =
          previous?.id === r.id ?
            { ...previous, hash: r.contentHash ?? '' }
          : { id: r.id, hash: r.contentHash ?? '', links: [], unknownLinks: true }
      }
      this.state.notes = known
      await this.persist()

      for (const path of local) this.queue.set(path, { kind: 'upsert', path })
      this.queue.forEach((p) => {
        if (p.kind === 'delete' && !known[p.path]) this.queue.delete(p.path)
      })
    })
    await this.flush()
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const previous = this.running ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    this.running = next.finally(() => {
      if (this.running === next) this.running = null
    })
    return next
  }

  private async apply(batch: Pending[]) {
    const upserts: string[] = []
    const removals: string[] = []
    for (const item of batch) {
      const gone = item.kind === 'delete' || !this.isIndexed(item.path) || !this.vault.file(item.path)
      if (!gone) upserts.push(item.path)
      else if (this.state.notes[item.path]) removals.push(item.path)
    }
    // Notes linking to a removed note still list it in `linksTo`: resend them.
    if (removals.length) {
      const removed = new Set(removals)
      const queued = new Set(upserts)
      for (const [path, note] of Object.entries(this.state.notes)) {
        if (!removed.has(path) && !queued.has(path) && note.links.some((p) => removed.has(p))) upserts.push(path)
      }
    }

    const resolvedLinks = this.vault.resolvedLinks()
    // Notes whose outgoing links are written, and those whose existing ones are cleared first.
    const relink = new Set<string>()
    const reset = new Set<string>()

    try {
      if (removals.length) await this.remove(removals)

      const created = await this.upsert(upserts, resolvedLinks, relink, reset)

      // Notes linking to a note created now gain it in `linksTo`: resend them.
      if (created.size) {
        const sent = new Set(upserts)
        const sources = Object.entries(resolvedLinks)
          .filter(
            ([source, targets]) =>
              !sent.has(source) && this.state.notes[source] && Object.keys(targets).some((t) => created.has(t))
          )
          .map(([source]) => source)
        await this.upsert(sources, resolvedLinks, relink, reset)
      }

      await this.writeLinks([...relink], [...reset])
    } finally {
      await this.persist()
      this.onProgress(null)
    }
  }

  /**
   * Reads and hashes the notes, sends those whose content or links changed in
   * batches, and collects whose links need writing. Returns the newly created paths.
   */
  private async upsert(paths: string[], resolvedLinks: ResolvedLinks, relink: Set<string>, reset: Set<string>) {
    const created = new Set<string>()
    let done = 0
    this.onProgress({ phase: 'notes', done, total: paths.length })

    for (const chunk of chunks(paths, READ_CHUNK)) {
      const linksByPath = new Map<string, string[]>()
      const changed: NoteRecord[] = []
      for (const prepared of await Promise.all(chunk.map((path) => this.prepare(path, resolvedLinks)))) {
        if (!prepared) continue
        linksByPath.set(prepared.path, prepared.links)
        if (prepared.record) changed.push(prepared.record)
        else if (this.state.notes[prepared.path]?.unknownLinks) {
          // An adopted, unchanged record: rebuild its links from the `linksTo` it holds.
          reset.add(prepared.path)
          if (prepared.links.length) relink.add(prepared.path)
        }
      }

      for (const batch of toBatches(changed)) {
        const ids = await withRetry(() => this.store.upsertNotes(batch))
        for (const record of batch) {
          const path = String(record.path)
          const id = ids[path]
          if (!id) throw new Error(`RushDB returned no record for ${path}`)
          const links = linksByPath.get(path) ?? []
          const known = this.state.notes[path]
          if (!known) created.add(path)
          // A new record has no links yet; an existing one may hold links it lost.
          const existing = known?.id === id ? known : undefined
          if (existing && (existing.unknownLinks || existing.links.some((p) => !links.includes(p)))) reset.add(path)
          if (links.length && (reset.has(path) || !sameList(existing?.links ?? [], links))) relink.add(path)
          this.state.notes[path] = { id, hash: String(record.contentHash), links }
        }
        // Saved per batch, so an interrupted first sync resumes where it stopped.
        await this.persist()
      }
      done += chunk.length
      this.onProgress({ phase: 'notes', done, total: paths.length })
    }
    return created
  }

  /** Reads and hashes a note; `record` is set only when its content or links changed. */
  private async prepare(path: string, resolvedLinks: ResolvedLinks) {
    const file = this.vault.file(path)
    if (!file) return null
    const links = outgoingLinks(path, resolvedLinks, this.isIndexed)
    const input = {
      vaultId: this.state.vaultId,
      path,
      basename: file.basename,
      mtime: file.mtime,
      text: await this.vault.read(path),
      metadata: this.vault.metadata(path),
      maxBodyChars: this.settings().maxBodyChars,
      links
    }
    const hash = await hashNote(input)
    if (this.state.notes[path]?.hash === hash) return { path, links }
    return { path, links, record: toNoteRecord(input, hash) }
  }

  private async remove(paths: string[]) {
    const ids = paths.map((p) => this.state.notes[p]?.id).filter((id): id is string => !!id)
    await withRetry(() => this.store.deleteNotes(ids))
    for (const path of paths) delete this.state.notes[path]
  }

  /** Clears the outgoing links of `reset`, then writes those of `relink`, a batch of notes per request. */
  private async writeLinks(relink: string[], reset: string[]) {
    const total = reset.length + relink.length
    if (!total) return
    let done = 0
    this.onProgress({ phase: 'links', done, total })
    for (const batch of chunks(reset, LINK_BATCH)) {
      await withRetry(() => this.store.unlinkNotes(batch))
      this.onProgress({ phase: 'links', done: (done += batch.length), total })
    }
    for (const batch of chunks(relink, LINK_BATCH)) {
      await withRetry(() => this.store.linkNotes(batch))
      this.onProgress({ phase: 'links', done: (done += batch.length), total })
    }
    for (const path of [...reset, ...relink]) {
      const note = this.state.notes[path]
      if (note) delete note.unknownLinks
    }
  }
}
