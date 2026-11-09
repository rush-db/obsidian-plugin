import { diffLinks, hashNote, outgoingLinks, toNoteRecord, type NoteMetadata, type NoteRecord } from './parse'
import { isIncluded, type NoteState, type RushDBSettings, type SyncState } from './settings'

/** The RushDB operations sync needs; `client.ts` implements it over the SDK. */
export interface Store {
  /** Creates or updates the note matched by `vaultId` + `path`; resolves to its record id. */
  upsertNote: (record: NoteRecord) => Promise<string>
  updateNote: (id: string, data: Partial<NoteRecord>) => Promise<void>
  deleteNotes: (ids: string[]) => Promise<void>
  link: (sourceId: string, targetIds: string[]) => Promise<void>
  unlink: (sourceId: string, targetIds: string[]) => Promise<void>
  /** Ids of the notes `sourceId` links to, as stored. */
  linkedFrom: (sourceId: string) => Promise<string[]>
  /** Every note of this vault: id, path and content hash. */
  listNotes: (vaultId: string) => Promise<Array<{ id: string; path: string; contentHash?: string }>>
}

/** The vault operations sync needs; `main.ts` implements it over Obsidian's API. */
export interface VaultSource {
  markdownFiles: () => Array<{ path: string; basename: string; mtime: number }>
  file: (path: string) => { path: string; basename: string; mtime: number } | null
  read: (path: string) => Promise<string>
  metadata: (path: string) => NoteMetadata | null
  resolvedLinks: () => Record<string, Record<string, number>>
}

export interface SyncProgress {
  done: number
  total: number
}

type Pending = { kind: 'upsert'; path: string } | { kind: 'delete'; path: string }

const RETRIES = 3

const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  let lastError: unknown
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => window.setTimeout(resolve, 250 * 2 ** attempt))
    }
  }
  throw lastError
}

/**
 * Keeps a vault's notes and links mirrored in RushDB. Markdown stays the source
 * of truth: sync only writes to RushDB, never to the vault.
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
      await withRetry(() => this.store.updateNote(known.id, { path: newPath, title, folder }))
      delete this.state.notes[oldPath]
      this.state.notes[newPath] = known
      for (const note of Object.values(this.state.notes)) {
        note.links = note.links.map((p) => (p === oldPath ? newPath : p))
      }
      await this.persist()
    })
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
      const local = new Set(this.vault.markdownFiles().map((f) => f.path).filter(this.isIndexed))

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
    const total = batch.length
    let done = 0
    const touched = new Set<string>()
    const created = new Set<string>()

    try {
      for (const item of batch) {
        this.onProgress({ done, total })
        if (item.kind === 'delete' || !this.isIndexed(item.path) || !this.vault.file(item.path)) {
          await this.remove(item.path)
        } else {
          const isNew = !this.state.notes[item.path]
          if (await this.upsert(item.path)) touched.add(item.path)
          if (isNew && this.state.notes[item.path]) created.add(item.path)
        }
        done++
      }

      // A note created in this batch may be the target of links in notes that did not change.
      if (created.size) {
        for (const [source, targets] of Object.entries(this.vault.resolvedLinks())) {
          if (this.state.notes[source] && Object.keys(targets).some((t) => created.has(t))) touched.add(source)
        }
      }
      for (const path of touched) await this.syncLinks(path)
    } finally {
      await this.persist()
      this.onProgress(null)
    }
  }

  /** Sends the note when its content changed; returns whether its links need a check. */
  private async upsert(path: string): Promise<boolean> {
    const file = this.vault.file(path)
    if (!file) return false
    const text = await this.vault.read(path)
    const input = {
      vaultId: this.state.vaultId,
      path,
      basename: file.basename,
      mtime: file.mtime,
      text,
      metadata: this.vault.metadata(path),
      maxBodyChars: this.settings().maxBodyChars
    }
    const hash = await hashNote(input)
    const known = this.state.notes[path]
    if (known && known.hash === hash) return true

    const id = await withRetry(() => this.store.upsertNote(toNoteRecord(input, hash)))
    this.state.notes[path] = { ...known, id, hash, links: known?.id === id ? known.links : [] }
    return true
  }

  private async remove(path: string) {
    const known = this.state.notes[path]
    if (!known) return
    await withRetry(() => this.store.deleteNotes([known.id]))
    delete this.state.notes[path]
    for (const note of Object.values(this.state.notes)) {
      note.links = note.links.filter((p) => p !== path)
    }
  }

  private async syncLinks(path: string) {
    const note = this.state.notes[path]
    if (!note) return

    const desired = outgoingLinks(path, this.vault.resolvedLinks(), this.isIndexed).filter(
      (target) => this.state.notes[target]
    )

    if (note.unknownLinks) {
      const byId = new Map(Object.entries(this.state.notes).map(([p, n]) => [n.id, p]))
      const stored = await withRetry(() => this.store.linkedFrom(note.id))
      note.links = stored.map((id) => byId.get(id)).filter((p): p is string => p !== undefined)
      const orphans = stored.filter((id) => !byId.has(id))
      if (orphans.length) await withRetry(() => this.store.unlink(note.id, orphans))
      delete note.unknownLinks
    }

    const { added, removed } = diffLinks(note.links, desired)
    const ids = (paths: string[]) => paths.map((p) => this.state.notes[p]?.id).filter((id): id is string => !!id)
    if (removed.length) await withRetry(() => this.store.unlink(note.id, ids(removed)))
    if (added.length) await withRetry(() => this.store.link(note.id, ids(added)))
    note.links = desired
  }
}
