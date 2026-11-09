import { beforeEach, describe, expect, it } from 'vitest'

import type { NoteRecord } from '../src/parse'
import { DEFAULT_SETTINGS, type RushDBSettings, type SyncState } from '../src/settings'
import { SyncEngine, type Store, type VaultSource } from '../src/sync'

/** An in-memory RushDB: notes by id and LINKS_TO edges as `source>target`. */
class FakeStore implements Store {
  notes = new Map<string, NoteRecord>()
  edges = new Set<string>()
  calls: string[] = []
  private seq = 0

  async upsertNote(record: NoteRecord) {
    this.calls.push(`upsert ${String(record.path)}`)
    const existing = [...this.notes].find(([, r]) => r.vaultId === record.vaultId && r.path === record.path)
    const id = existing?.[0] ?? `n${++this.seq}`
    this.notes.set(id, record)
    return id
  }
  async updateNote(id: string, data: Partial<NoteRecord>) {
    this.calls.push(`update ${id}`)
    this.notes.set(id, { ...this.notes.get(id)!, ...data } as NoteRecord)
  }
  async deleteNotes(ids: string[]) {
    for (const id of ids) {
      this.calls.push(`delete ${id}`)
      this.notes.delete(id)
      for (const e of this.edges) if (e.startsWith(`${id}>`) || e.endsWith(`>${id}`)) this.edges.delete(e)
    }
  }
  async link(source: string, targets: string[]) {
    for (const t of targets) this.edges.add(`${source}>${t}`)
  }
  async unlink(source: string, targets: string[]) {
    for (const t of targets) this.edges.delete(`${source}>${t}`)
  }
  async linkedFrom(source: string) {
    return [...this.edges].filter((e) => e.startsWith(`${source}>`)).map((e) => e.split('>')[1])
  }
  async listNotes(vaultId: string) {
    return [...this.notes]
      .filter(([, r]) => r.vaultId === vaultId)
      .map(([id, r]) => ({ id, path: String(r.path), contentHash: String(r.contentHash) }))
  }

  pathOf(id: string) {
    return this.notes.get(id)?.path
  }
  /** Edges as `sourcePath>targetPath`, sorted. */
  links() {
    return [...this.edges].map((e) => e.split('>').map((id) => this.pathOf(id)).join('>')).sort()
  }
}

/** An in-memory vault whose links are parsed from `[[name]]`. */
class FakeVault implements VaultSource {
  files = new Map<string, string>()

  markdownFiles() {
    return [...this.files.keys()].map((path) => this.file(path)!)
  }
  file(path: string) {
    return this.files.has(path) ? { path, basename: path.replace(/^.*\//, '').replace(/\.md$/, ''), mtime: 0 } : null
  }
  async read(path: string) {
    return this.files.get(path) ?? ''
  }
  metadata() {
    return null
  }
  resolvedLinks() {
    const links: Record<string, Record<string, number>> = {}
    for (const [path, text] of this.files) {
      links[path] = {}
      for (const [, name] of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const target = [...this.files.keys()].find((p) => p.replace(/^.*\//, '') === `${name}.md`)
        if (target) links[path][target] = 1
      }
    }
    return links
  }
}

describe('SyncEngine', () => {
  let vault: FakeVault
  let store: FakeStore
  let state: SyncState
  let settings: RushDBSettings
  let sync: SyncEngine

  const engine = () => new SyncEngine(vault, store, () => settings, state, async () => {})

  beforeEach(() => {
    vault = new FakeVault()
    store = new FakeStore()
    state = { vaultId: 'v1', notes: {} }
    settings = { ...DEFAULT_SETTINGS, includeFolders: ['/'], excludeFolders: ['private'] }
    vault.files.set('a.md', 'see [[b]] and [[secret]]')
    vault.files.set('notes/b.md', 'back to [[a]]')
    vault.files.set('private/secret.md', 'hidden')
    sync = engine()
  })

  it('indexes included notes and the links between them', async () => {
    await sync.reconcile()
    expect([...store.notes.values()].map((r) => r.path).sort()).toEqual(['a.md', 'notes/b.md'])
    expect(store.links()).toEqual(['a.md>notes/b.md', 'notes/b.md>a.md'])
  })

  it('skips unchanged notes', async () => {
    await sync.reconcile()
    store.calls = []
    sync.enqueue('a.md')
    await sync.flush()
    expect(store.calls).toEqual([])
  })

  it('updates links when a note changes', async () => {
    await sync.reconcile()
    vault.files.set('a.md', 'no links now')
    sync.enqueue('a.md')
    await sync.flush()
    expect(store.links()).toEqual(['notes/b.md>a.md'])
  })

  it('links to a note created later', async () => {
    vault.files.set('a.md', 'see [[c]]')
    await sync.reconcile()
    vault.files.set('c.md', 'new')
    sync.enqueue('c.md')
    await sync.flush()
    expect(store.links()).toContain('a.md>c.md')
  })

  it('keeps the record and its links on rename', async () => {
    await sync.reconcile()
    const id = state.notes['notes/b.md'].id
    vault.files.set('archive/b.md', vault.files.get('notes/b.md')!)
    vault.files.delete('notes/b.md')
    await sync.rename('notes/b.md', 'archive/b.md')
    expect(state.notes['archive/b.md'].id).toBe(id)
    expect(store.notes.get(id)).toMatchObject({ path: 'archive/b.md', folder: 'archive', title: 'b' })
    expect(state.notes['a.md'].links).toEqual(['archive/b.md'])
    expect(store.links()).toEqual(['a.md>archive/b.md', 'archive/b.md>a.md'])
  })

  it('removes a note moved out of the index', async () => {
    await sync.reconcile()
    vault.files.set('private/b.md', vault.files.get('notes/b.md')!)
    vault.files.delete('notes/b.md')
    await sync.rename('notes/b.md', 'private/b.md')
    expect([...store.notes.values()].map((r) => r.path)).toEqual(['a.md'])
    expect(store.links()).toEqual([])
  })

  it('deletes notes and their links', async () => {
    await sync.reconcile()
    vault.files.delete('a.md')
    sync.enqueueDelete('a.md')
    await sync.flush()
    expect([...store.notes.values()].map((r) => r.path)).toEqual(['notes/b.md'])
    expect(store.links()).toEqual([])
    expect(state.notes['notes/b.md'].links).toEqual([])
  })

  it('catches up with changes made while it was off and drops excluded notes', async () => {
    await sync.reconcile()
    vault.files.delete('notes/b.md')
    vault.files.set('c.md', '[[a]]')
    settings.excludeFolders = ['private']
    await engine().reconcile()
    expect([...store.notes.values()].map((r) => r.path).sort()).toEqual(['a.md', 'c.md'])
    expect(store.links()).toEqual(['c.md>a.md'])
  })

  it('adopts existing records without duplicating their links', async () => {
    await sync.reconcile()
    state.notes = {}
    store.calls = []
    await engine().reconcile()
    expect(store.notes.size).toBe(2)
    expect(store.links()).toEqual(['a.md>notes/b.md', 'notes/b.md>a.md'])
    expect(store.calls.filter((c) => c.startsWith('upsert'))).toEqual([])
  })
})
