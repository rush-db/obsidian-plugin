import { beforeEach, describe, expect, it } from 'vitest'

import type { NoteRecord } from '../src/parse'
import { DEFAULT_SETTINGS, type RushDBSettings, type SyncState } from '../src/settings'
import { BATCH_NOTES, SyncEngine, toBatches, type Store, type VaultSource } from '../src/sync'

/** An in-memory RushDB: notes by id and LINKS_TO edges as `source>target`. */
class FakeStore implements Store {
  notes = new Map<string, NoteRecord>()
  edges = new Set<string>()
  calls: string[] = []
  private seq = 0

  batches: number[] = []
  private idByKey = new Map<string, string>()

  async upsertNotes(records: NoteRecord[]) {
    this.batches.push(records.length)
    const ids: Record<string, string> = {}
    for (const record of records) {
      this.calls.push(`upsert ${String(record.path)}`)
      const key = `${String(record.vaultId)}/${String(record.path)}`
      const id = this.idByKey.get(key) ?? `n${++this.seq}`
      this.idByKey.set(key, id)
      this.notes.set(id, record)
      ids[String(record.path)] = id
    }
    return ids
  }
  async updateNote(id: string, data: Partial<NoteRecord>) {
    this.calls.push(`update ${id}`)
    const before = this.notes.get(id)!
    const after = { ...before, ...data } as NoteRecord
    this.idByKey.delete(`${String(before.vaultId)}/${String(before.path)}`)
    this.idByKey.set(`${String(after.vaultId)}/${String(after.path)}`, id)
    this.notes.set(id, after)
  }
  async deleteNotes(ids: string[]) {
    for (const id of ids) {
      this.calls.push(`delete ${id}`)
      const record = this.notes.get(id)
      if (record) this.idByKey.delete(`${String(record.vaultId)}/${String(record.path)}`)
      this.notes.delete(id)
      for (const e of this.edges) if (e.startsWith(`${id}>`) || e.endsWith(`>${id}`)) this.edges.delete(e)
    }
  }
  linkRequests: number[] = []
  unlinkRequests: number[] = []

  /** Like the engine's key join: each source's `linksTo` against `linkKey`, within the vault; existing edges kept. */
  async linkNotes(paths: string[]) {
    this.linkRequests.push(paths.length)
    for (const [sourceId, source] of this.notes) {
      if (source.vaultId !== 'v1' || !paths.includes(String(source.path))) continue
      const targets = Array.isArray(source.linksTo) ? source.linksTo : []
      for (const [targetId, target] of this.notes) {
        if (target.vaultId === 'v1' && targets.includes(target.linkKey as string)) this.edges.add(`${sourceId}>${targetId}`)
      }
    }
  }
  async unlinkNotes(paths: string[]) {
    this.unlinkRequests.push(paths.length)
    for (const [sourceId, source] of this.notes) {
      if (!paths.includes(String(source.path))) continue
      for (const e of this.edges) if (e.startsWith(`${sourceId}>`)) this.edges.delete(e)
    }
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
    const byName = new Map([...this.files.keys()].map((p) => [p.replace(/^.*\//, ''), p]))
    const links: Record<string, Record<string, number>> = {}
    for (const [path, text] of this.files) {
      links[path] = {}
      for (const [, name] of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const target = byName.get(`${name}.md`)
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
    // The note that linked to it was resent without it.
    expect([...store.notes.values()].find((r) => r.path === 'notes/b.md')).not.toHaveProperty('linksTo')
  })

  it('links again when a deleted note comes back', async () => {
    await sync.reconcile()
    const text = vault.files.get('a.md')!
    vault.files.delete('a.md')
    sync.enqueueDelete('a.md')
    await sync.flush()
    vault.files.set('a.md', text)
    sync.enqueue('a.md')
    await sync.flush()
    expect(store.links()).toEqual(['a.md>notes/b.md', 'notes/b.md>a.md'])
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

  it('sends a large vault in batches and saves progress per batch', async () => {
    vault.files.clear()
    for (let i = 0; i < 1050; i++) vault.files.set(`n${i}.md`, `note ${i} [[n${(i + 1) % 1050}]]`)
    let saves = 0
    const progress: string[] = []
    const big = new SyncEngine(vault, store, () => settings, state, async () => void saves++, (p) => {
      if (p) progress.push(p.phase)
    })
    await big.reconcile()
    expect(store.notes.size).toBe(1050)
    expect(Math.max(...store.batches)).toBeLessThanOrEqual(BATCH_NOTES)
    expect(store.batches.length).toBe(11)
    expect(saves).toBeGreaterThanOrEqual(11)
    expect(store.edges.size).toBe(1050)
    // One link request per 500 source notes, nothing to clear on a first sync.
    expect(store.linkRequests).toEqual([500, 500, 50])
    expect(store.unlinkRequests).toEqual([])
    expect(progress).toContain('notes')
    expect(progress).toContain('links')

    store.batches = []
    store.linkRequests = []
    await big.reconcile()
    expect(store.batches).toEqual([])
    expect(store.linkRequests).toEqual([])
  })
})

describe('toBatches', () => {
  const note = (body: string) => ({ vaultId: 'v', path: 'p.md', body })

  it('splits by count', () => {
    expect(toBatches(Array.from({ length: 5 }, () => note('x')), 2).map((b) => b.length)).toEqual([2, 2, 1])
  })

  it('splits by size, keeping an oversized note on its own', () => {
    const sizes = toBatches([note('a'.repeat(60)), note('b'.repeat(60)), note('c'.repeat(500)), note('d')], 100, 200)
    expect(sizes.map((b) => b.length)).toEqual([2, 1, 1])
  })
})

