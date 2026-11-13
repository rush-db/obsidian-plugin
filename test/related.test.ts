import { describe, expect, it } from 'vitest'

import { rankBySharedTags, toHit, type NoteHit } from '../src/client'
import { formatScore } from '../src/format'

const hit = (path: string, tags: string[]): NoteHit => ({ id: path, path, title: path, tags })

describe('related notes', () => {
  it('reads a search score from the record data', () => {
    expect(toHit({ id: 'a', data: { path: 'a.md', __score: 0.9812 } }).score).toBe(0.9812)
    expect(toHit({ id: 'a', data: { path: 'a.md' } }).score).toBeUndefined()
  })

  it('keeps a note’s tags', () => {
    expect(toHit({ id: 'a', data: { path: 'a.md', tags: ['db', 3, 'ann'] } }).tags).toEqual(['db', 'ann'])
  })

  it('puts the notes sharing the most tags first and says which', () => {
    const ranked = rankBySharedTags(
      [hit('one.md', ['db']), hit('three.md', ['ann', 'db', 'graph']), hit('two.md', ['graph', 'x', 'db']), hit('none.md', ['x'])],
      ['db', 'ann', 'graph'],
      10
    )
    expect(ranked.map((n) => [n.path, n.matchedTags])).toEqual([
      ['three.md', ['db', 'ann', 'graph']],
      ['two.md', ['db', 'graph']],
      ['one.md', ['db']]
    ])
  })

  it('keeps the server order between notes with as many shared tags, up to the limit', () => {
    const ranked = rankBySharedTags([hit('b.md', ['db']), hit('a.md', ['db']), hit('c.md', ['db'])], ['db'], 2)
    expect(ranked.map((n) => n.path)).toEqual(['b.md', 'a.md'])
  })

  it('writes a similarity with two decimals and a keyword relevance with one', () => {
    expect(formatScore(0.9812)).toBe('0.98')
    expect(formatScore(1)).toBe('1.00')
    expect(formatScore(7.346)).toBe('7.3')
  })
})
