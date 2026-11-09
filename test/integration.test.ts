import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { RushDBVault, createDb, supportsEmbeddings } from '../src/client'
import type { Transport } from '../src/http'
import { DEFAULT_SETTINGS, type RushDBSettings, type SyncState } from '../src/settings'
import { SyncEngine, type VaultSource } from '../src/sync'

/**
 * Runs sync and the view queries against a real server. Opt-in, from the
 * environment or a git-ignored `.env.test`:
 *
 * - RUSHDB_API_KEY (+ RUSHDB_API_URL, default https://api.rushdb.com): through the
 *   RushDB API. Set RUSHDB_EMBEDDINGS=1 to also test semantic search, which
 *   creates a managed embedding index on NOTE.body in that project.
 * - RUSHDB_ENGINE_URL (+ RUSHDB_ENGINE_TOKEN): a standalone engine, in a fresh tenant.
 *
 * Every run writes under its own vault id and deletes its notes at the end. It
 * leaves the NOTE text index (and embedding index) in place; use a test project.
 */
const env = process.env
const target =
  env.RUSHDB_API_KEY ? 'api'
  : env.RUSHDB_ENGINE_URL ? 'engine'
  : null

const runId = Date.now()

const settingsFor = (): RushDBSettings => ({
  ...DEFAULT_SETTINGS,
  ...(target === 'api' ?
    {
      mode: 'api',
      apiUrl: env.RUSHDB_API_URL || DEFAULT_SETTINGS.apiUrl,
      embeddings: env.RUSHDB_EMBEDDINGS === '1'
    }
  : {
      mode: 'engine',
      engineUrl: env.RUSHDB_ENGINE_URL ?? '',
      engineScope: `obsidian-plugin-test-${runId}`
    }),
  includeFolders: ['/']
})

const credentials = { apiKey: env.RUSHDB_API_KEY ?? '', engineToken: env.RUSHDB_ENGINE_TOKEN ?? '' }

const fetchTransport: Transport = async ({ url, method, headers, body }) => {
  // Node test transport; the plugin itself uses Obsidian's requestUrl.
  const res = await fetch(url, { method, headers, body })
  return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() }
}

type Files = Map<string, { text: string; tags: string[] }>

const vaultSourceOf = (files: Files): VaultSource => {
  const source: VaultSource = {
    indexedFiles: () => [...files.keys()].map((path) => source.file(path)!),
    file: (path) =>
      files.has(path) ? { path, basename: path.replace(/^.*\//, '').replace(/\.md$/, ''), mtime: Date.UTC(2026, 10, 1) } : null,
    read: async (path) => files.get(path)?.text ?? '',
    metadata: (path) => ({ tags: (files.get(path)?.tags ?? []).map((tag) => ({ tag: `#${tag}` })) }),
    resolvedLinks: () => {
      const byName = new Map([...files.keys()].map((p) => [p.replace(/^.*\//, ''), p]))
      const links: Record<string, Record<string, number>> = {}
      for (const [path, { text }] of files) {
        links[path] = {}
        for (const [, name] of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
          const linked = byName.get(`${name}.md`)
          if (linked) links[path][linked] = 1
        }
      }
      return links
    }
  }
  return source
}

const eventually = async <T>(fn: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 30_000) => {
  const start = Date.now()
  let value = await fn()
  while (!ok(value) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    value = await fn()
  }
  return value
}

const setup = (vaultId: string, files: Files) => {
  const settings = settingsFor()
  const state: SyncState = { vaultId, notes: {} }
  const vault = new RushDBVault(createDb(settings, credentials, fetchTransport), vaultId, settings)
  const sync = new SyncEngine(vaultSourceOf(files), vault, () => settings, state, async () => {})
  return { settings, state, vault, sync }
}

describe.skipIf(!target)(`against RushDB (${target ?? 'skipped'})`, () => {
  const files: Files = new Map([
    ['projects/graph.md', { text: 'Graph engines store [[vectors]] next to records.', tags: ['db'] }],
    ['projects/vectors.md', { text: 'HNSW indexes for approximate nearest neighbour search. See [[ideas]].', tags: ['db', 'ann'] }],
    ['ideas.md', { text: 'Ideas about gardening and tomatoes.', tags: [] }]
  ])
  let t: ReturnType<typeof setup>

  beforeAll(() => {
    t = setup(`test-vault-${runId}`, files)
  })

  afterAll(async () => {
    await t?.vault.purgeVault()
  })

  it('creates the indexes and syncs notes with their links', async () => {
    await t.vault.ensureIndexes()
    await t.sync.reconcile()
    const notes = await t.vault.listNotes(t.state.vaultId)
    expect(notes.map((n) => n.path).sort()).toEqual(['ideas.md', 'projects/graph.md', 'projects/vectors.md'])
    for (const n of notes) expect(n.id).toBe(t.state.notes[n.path].id)
    expect(await t.vault.linkedFrom(t.state.notes['projects/graph.md'].id)).toEqual([t.state.notes['projects/vectors.md'].id])
  }, 60_000)

  it('does not duplicate records or links on a second sync', async () => {
    t.state.notes = {}
    await t.sync.reconcile()
    expect(await t.vault.listNotes(t.state.vaultId)).toHaveLength(3)
    expect(await t.vault.linkedFrom(t.state.notes['projects/graph.md'].id)).toHaveLength(1)
  }, 60_000)

  it('finds notes by keyword', async () => {
    // The text index applies changes shortly after they commit.
    const hits = await eventually(
      () => t.vault.search('nearest neighbour'),
      (h) => h[0]?.path === 'projects/vectors.md'
    )
    expect(hits[0]?.path).toBe('projects/vectors.md')
  }, 60_000)

  it('answers the related-notes queries', async () => {
    const note = {
      path: 'projects/vectors.md',
      title: 'vectors',
      headings: [],
      text: files.get('projects/vectors.md')!.text,
      tags: ['db', 'ann']
    }
    const related = await t.vault.related(note)
    expect(related.outgoing.map((n) => n.path)).toEqual(['ideas.md'])
    expect(related.backlinks.map((n) => n.path)).toEqual(['projects/graph.md'])
    expect(related.twoHops.map((n) => n.path)).toEqual([])
    expect(related.sharedTags.map((n) => n.path)).toEqual(['projects/graph.md'])
  }, 60_000)

  it.skipIf(target !== 'api' || env.RUSHDB_EMBEDDINGS !== '1')('ranks by meaning with embeddings on', async () => {
    expect(supportsEmbeddings(t.settings)).toBe(true)
    // Vector-only, with a query sharing no word with any note, so a keyword match
    // or the default order cannot pass it. Managed embeddings are computed shortly
    // after each write (the index reads `pending` until then), so wait for them.
    const db = createDb(t.settings, credentials, fetchTransport)
    const query = 'similarity lookup over embeddings'
    const result = await eventually(
      () => db.records.vectorSearch({ labels: ['NOTE'], propertyName: 'body', query, where: { vaultId: t.state.vaultId }, limit: 5 }),
      (r) => (r.vectorSearch?.pool ?? 0) > 0 && r.data.length > 0,
      120_000
    )
    expect(result.vectorSearch?.pool).toBeGreaterThan(0)
    expect(result.data[0]?.data.path).toBe('projects/vectors.md')
    expect((await t.vault.search(query))[0]?.path).toBe('projects/vectors.md')
  }, 150_000)

  it('renames in place and removes deleted notes', async () => {
    const id = t.state.notes['ideas.md'].id
    files.set('archive/ideas.md', files.get('ideas.md')!)
    files.delete('ideas.md')
    await t.sync.rename('ideas.md', 'archive/ideas.md')
    expect(t.state.notes['archive/ideas.md'].id).toBe(id)

    files.delete('projects/graph.md')
    t.sync.enqueueDelete('projects/graph.md')
    await t.sync.flush()
    const paths = (await t.vault.listNotes(t.state.vaultId)).map((n) => n.path).sort()
    expect(paths).toEqual(['archive/ideas.md', 'projects/vectors.md'])
  }, 60_000)
})

describe.skipIf(!target)(`a large vault against RushDB (${target ?? 'skipped'})`, () => {
  const COUNT = 1200
  const files: Files = new Map()
  for (let i = 0; i < COUNT; i++) {
    files.set(`bulk/n${i}.md`, { text: `Note ${i}. ${'Some text. '.repeat(40)} [[n${(i + 1) % COUNT}]]`, tags: [`t${i % 7}`] })
  }
  let t: ReturnType<typeof setup>

  beforeAll(() => {
    t = setup(`test-vault-bulk-${runId}`, files)
  })

  afterAll(async () => {
    await t?.vault.purgeVault()
  }, 120_000)

  it('syncs in batches, then skips everything on a resync', async () => {
    await t.vault.ensureIndexes()
    const started = Date.now()
    await t.sync.reconcile()
    const firstSync = Date.now() - started

    const notes = await t.vault.listNotes(t.state.vaultId)
    expect(notes).toHaveLength(COUNT)
    for (const n of notes) expect(n.id).toBe(t.state.notes[n.path].id)
    expect(await t.vault.linkedFrom(t.state.notes['bulk/n5.md'].id)).toEqual([t.state.notes['bulk/n6.md'].id])

    if (target === 'api') {
      // Link writes must not be saved as an approved join pattern the platform
      // re-applies. (Its suggestion analysis may still propose one; that needs approval.)
      const { data } = await createDb(t.settings, credentials, fetchTransport).relationships.patterns.list()
      const saved = (data?.patterns ?? []).filter((p) => p.status === 'approved' && p.source.key === 'linksTo')
      expect(saved).toEqual([])
    }

    const again = Date.now()
    await t.sync.reconcile()
    console.log(`${target}: first sync of ${COUNT} notes ${firstSync} ms, unchanged resync ${Date.now() - again} ms`)
  }, 600_000)
})

describe.skipIf(!target)(`two vaults in one project against RushDB (${target ?? 'skipped'})`, () => {
  const files = (): Files =>
    new Map([
      ['a.md', { text: 'See [[b]].', tags: [] }],
      ['b.md', { text: 'Target.', tags: [] }]
    ])
  let first: ReturnType<typeof setup>
  let second: ReturnType<typeof setup>

  beforeAll(() => {
    first = setup(`test-vault-a-${runId}`, files())
    second = setup(`test-vault-b-${runId}`, files())
  })

  afterAll(async () => {
    await first?.vault.purgeVault()
    await second?.vault.purgeVault()
  }, 60_000)

  it('links notes within their own vault only', async () => {
    await first.sync.reconcile()
    await second.sync.reconcile()
    // Every note `a.md` links to, in any vault: only its own vault's `b.md`.
    const db = createDb(first.settings, credentials, fetchTransport)
    const linked = async (sourceId: string) => {
      const result = await db.records.find({
        labels: ['NOTE'],
        where: { NOTE: { $relation: { type: 'LINKS_TO', direction: 'in' }, $id: sourceId } }
      } as never)
      return result.data.map((r) => r.id)
    }
    expect(await linked(first.state.notes['a.md'].id)).toEqual([first.state.notes['b.md'].id])
    expect(await linked(second.state.notes['a.md'].id)).toEqual([second.state.notes['b.md'].id])
  }, 60_000)
})
