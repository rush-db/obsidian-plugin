import { describe, expect, it } from 'vitest'

import {
  collectTags,
  frontmatterKey,
  hashNote,
  outgoingLinks,
  stripFrontmatter,
  toNoteRecord,
  type NoteInput
} from '../src/parse'
import { toRecordId } from '../src/client'
import { collectIndexedFiles, isIncluded, type FolderNode } from '../src/settings'

const input = (overrides: Partial<NoteInput> = {}): NoteInput => ({
  vaultId: 'v1',
  path: 'projects/RushDB.md',
  basename: 'RushDB',
  mtime: Date.UTC(2026, 10, 1),
  text: '---\nstatus: draft\n---\n# RushDB\nGraph notes #db',
  metadata: {
    frontmatter: { status: 'draft', 'Due date': '2026-12-01', priority: 2, done: false, owners: ['a', 'b'], nested: { x: 1 }, position: {} },
    headings: [{ heading: 'RushDB', level: 1 }],
    tags: [{ tag: '#db' }]
  },
  maxBodyChars: 1000,
  links: [],
  ...overrides
})

describe('toNoteRecord', () => {
  it('flattens a note into one record', () => {
    expect(toNoteRecord(input(), 'h')).toEqual({
      vaultId: 'v1',
      path: 'projects/RushDB.md',
      title: 'RushDB',
      folder: 'projects',
      modifiedAt: '2026-11-01T00:00:00.000Z',
      contentHash: 'h',
      linkKey: 'v1:projects/RushDB.md',
      body: '# RushDB\nGraph notes #db',
      tags: ['db'],
      headings: ['RushDB'],
      fm_status: 'draft',
      fm_due_date: '2026-12-01',
      fm_priority: 2,
      fm_done: false,
      fm_owners: ['a', 'b']
    })
  })

  it('cuts the body and leaves out empty values', () => {
    const record = toNoteRecord(input({ path: 'Top.md', text: 'x'.repeat(50), metadata: null, maxBodyChars: 10 }), 'h')
    expect(record.body).toBe('x'.repeat(10))
    expect(record.folder).toBe('')
    expect(record).not.toHaveProperty('tags')
  })

  it('turns mixed arrays into strings', () => {
    const record = toNoteRecord(input({ metadata: { frontmatter: { mixed: [1, 'two', true] } } }), 'h')
    expect(record.fm_mixed).toEqual(['1', 'two', 'true'])
  })
})

describe('helpers', () => {
  it('normalizes frontmatter keys', () => {
    expect(frontmatterKey(' Due date ')).toBe('fm_due_date')
    expect(frontmatterKey('kebab-Case')).toBe('fm_kebab_case')
  })

  it('merges body and property tags', () => {
    expect(collectTags({ tags: [{ tag: '#b' }], frontmatter: { tags: ['a', '#b'] } })).toEqual(['a', 'b'])
    expect(collectTags({ frontmatter: { tags: 'x, y' } })).toEqual(['x', 'y'])
  })

  it('strips frontmatter only at the start', () => {
    expect(stripFrontmatter('---\na: 1\n---\nbody\n---\n')).toBe('body\n---\n')
    expect(stripFrontmatter('body')).toBe('body')
  })

  it('hashes content and the body limit', async () => {
    const a = await hashNote(input())
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await hashNote(input())).toBe(a)
    expect(await hashNote(input({ maxBodyChars: 5 }))).not.toBe(a)
  })

  it('keeps links to indexed notes only', () => {
    const links = { 'a.md': { 'b.md': 1, 'a.md': 1, 'img.png': 1, 'private/c.md': 2 } }
    expect(outgoingLinks('a.md', links, (p) => !p.startsWith('private/'))).toEqual(['b.md'])
  })

  it('records links as linksTo and hashes them', async () => {
    expect(toNoteRecord(input({ links: ['b.md'] }), 'h').linksTo).toEqual(['v1:b.md'])
    expect(toNoteRecord(input(), 'h')).not.toHaveProperty('linksTo')
    expect(await hashNote(input({ links: ['b.md'] }))).not.toBe(await hashNote(input()))
  })

  it('selects folders', () => {
    const s = { includeFolders: ['/'], excludeFolders: ['private/'] }
    expect(isIncluded('notes/a.md', s)).toBe(true)
    expect(isIncluded('private/a.md', s)).toBe(false)
    expect(isIncluded('privateer.md', s)).toBe(true)
    expect(isIncluded('a.md', { includeFolders: [], excludeFolders: [] })).toBe(false)
    expect(isIncluded('work/a.md', { includeFolders: ['work'], excludeFolders: [] })).toBe(true)
    expect(isIncluded('workshop/a.md', { includeFolders: ['work'], excludeFolders: [] })).toBe(false)
  })

  it('formats selected record ids as UUIDs', () => {
    expect(toRecordId('01a1c1619e1677f289682923b9227bf0')).toBe('01a1c161-9e16-77f2-8968-2923b9227bf0')
    expect(toRecordId('01a1c161-9e16-77f2-8968-2923b9227bf0')).toBe('01a1c161-9e16-77f2-8968-2923b9227bf0')
  })

  it('walks only the chosen folders, skipping excluded ones', () => {
    const file = (path: string) => ({ path, extension: path.split('.').pop() ?? '' })
    const folder = (path: string, children: FolderNode['children']): FolderNode => ({ path, children })
    const tree = folder('', [
      file('top.md'),
      folder('work', [file('work/a.md'), file('work/img.png'), folder('work/private', [file('work/private/s.md')])]),
      folder('journal', [file('journal/day.md')])
    ])
    const byPath = new Map<string, FolderNode>()
    const index = (f: FolderNode) => {
      byPath.set(f.path, f)
      for (const c of f.children) if ('children' in c) index(c as FolderNode)
    }
    index(tree)
    const paths = (include: string[], exclude: string[] = []) =>
      collectIndexedFiles({ includeFolders: include, excludeFolders: exclude }, (p) => byPath.get(p) ?? null)
        .map((f) => f.path)
        .sort()

    expect(paths(['work'], ['work/private/'])).toEqual(['work/a.md'])
    expect(paths(['/', 'work'], ['journal'])).toEqual(['top.md', 'work/a.md', 'work/private/s.md'])
    expect(paths(['missing'])).toEqual([])
    expect(paths([])).toEqual([])
  })
})

