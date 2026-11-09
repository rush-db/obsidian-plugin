import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { RushDBVault, createDb } from '../src/client'
import type { Transport } from '../src/http'
import { DEFAULT_SETTINGS, type RushDBSettings, type SyncState } from '../src/settings'
import { SyncEngine, type VaultSource } from '../src/sync'

/**
 * Runs sync and the view queries against a real engine. Opt-in: set
 * RUSHDB_ENGINE_URL (e.g. http://127.0.0.1:3999 for `rushdb serve --multitenant`)
 * and RUSHDB_ENGINE_TOKEN when the engine runs with `--token`.
 * Each run uses its own tenant and removes its notes at the end.
 */
const engineUrl = process.env.RUSHDB_ENGINE_URL
const engineToken = process.env.RUSHDB_ENGINE_TOKEN ?? ''

const fetchTransport: Transport = async ({ url, method, headers, body }) => {
  // Node test transport; the plugin itself uses Obsidian's requestUrl.
  const res = await fetch(url, { method, headers, body })
  return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() }
}

const files = new Map<string, { text: string; tags: string[] }>([
  ['projects/graph.md', { text: 'Graph engines store [[vectors]] next to records.', tags: ['db'] }],
  ['projects/vectors.md', { text: 'HNSW indexes for approximate nearest neighbour search. See [[ideas]].', tags: ['db', 'ann'] }],
  ['ideas.md', { text: 'Ideas about gardening and tomatoes.', tags: [] }]
])

const vaultSource: VaultSource = {
  markdownFiles: () => [...files.keys()].map((path) => vaultSource.file(path)!),
  file: (path) =>
    files.has(path) ? { path, basename: path.replace(/^.*\//, '').replace(/\.md$/, ''), mtime: Date.UTC(2026, 10, 1) } : null,
  read: async (path) => files.get(path)?.text ?? '',
  metadata: (path) => ({ tags: (files.get(path)?.tags ?? []).map((tag) => ({ tag: `#${tag}` })) }),
  resolvedLinks: () => {
    const links: Record<string, Record<string, number>> = {}
    for (const [path, { text }] of files) {
      links[path] = {}
      for (const [, name] of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const target = [...files.keys()].find((p) => p.endsWith(`${name}.md`))
        if (target) links[path][target] = 1
      }
    }
    return links
  }
}

describe.skipIf(!engineUrl)('against a RushDB engine', () => {
  const state: SyncState = { vaultId: 'test-vault', notes: {} }
  let vault: RushDBVault
  let sync: SyncEngine

  beforeAll(() => {
    const settings: RushDBSettings = {
      ...DEFAULT_SETTINGS,
      mode: 'engine',
      engineUrl: engineUrl ?? '',
      engineToken,
      engineScope: `obsidian-plugin-test-${Date.now()}`,
      includeFolders: ['/']
    }
    vault = new RushDBVault(createDb(settings, fetchTransport), state.vaultId, settings)
    sync = new SyncEngine(vaultSource, vault, () => settings, state, async () => {})
  })

  afterAll(async () => {
    await vault.purgeVault()
  })

  it('creates the text index and syncs notes with their links', async () => {
    await vault.ensureIndexes()
    await sync.reconcile()
    const notes = await vault.listNotes(state.vaultId)
    expect(notes.map((n) => n.path).sort()).toEqual(['ideas.md', 'projects/graph.md', 'projects/vectors.md'])
    expect(await vault.linkedFrom(state.notes['projects/graph.md'].id)).toEqual([state.notes['projects/vectors.md'].id])
  })

  it('does not duplicate records or links on a second sync', async () => {
    state.notes = {}
    await sync.reconcile()
    expect(await vault.listNotes(state.vaultId)).toHaveLength(3)
    expect(await vault.linkedFrom(state.notes['projects/graph.md'].id)).toHaveLength(1)
  })

  it('finds notes by keyword', async () => {
    // The text index applies changes shortly after they commit.
    let hits = await vault.search('nearest neighbour')
    for (let i = 0; i < 20 && !hits.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      hits = await vault.search('nearest neighbour')
    }
    expect(hits[0]?.path).toBe('projects/vectors.md')
  })

  it('answers the related-notes queries', async () => {
    const related = await vault.related({
      path: 'projects/vectors.md',
      title: 'vectors',
      headings: [],
      text: files.get('projects/vectors.md')!.text,
      tags: ['db', 'ann']
    })
    expect(related.outgoing.map((n) => n.path)).toEqual(['ideas.md'])
    expect(related.backlinks.map((n) => n.path)).toEqual(['projects/graph.md'])
    expect(related.twoHops.map((n) => n.path)).toEqual([])
    expect(related.sharedTags.map((n) => n.path)).toEqual(['projects/graph.md'])
  })

  it('renames in place and removes deleted notes', async () => {
    const id = state.notes['ideas.md'].id
    files.set('archive/ideas.md', files.get('ideas.md')!)
    files.delete('ideas.md')
    await sync.rename('ideas.md', 'archive/ideas.md')
    expect(state.notes['archive/ideas.md'].id).toBe(id)

    files.delete('projects/graph.md')
    sync.enqueueDelete('projects/graph.md')
    await sync.flush()
    const paths = (await vault.listNotes(state.vaultId)).map((n) => n.path).sort()
    expect(paths).toEqual(['archive/ideas.md', 'projects/vectors.md'])
  })
})
