import { App, Notice, SuggestModal } from 'obsidian'

import type { NoteHit, RushDBVault } from './client'

const DEBOUNCE_MS = 250

/** Searches the indexed notes in RushDB: keyword (BM25), or hybrid with embeddings on. */
export class SearchModal extends SuggestModal<NoteHit> {
  private timer: number | null = null
  private lastError: string | null = null

  constructor(
    app: App,
    private readonly vault: RushDBVault
  ) {
    super(app)
    this.setPlaceholder('Search notes in RushDB…')
    this.emptyStateText = 'Type to search.'
    this.limit = 30
  }

  getSuggestions(query: string): Promise<NoteHit[]> {
    if (this.timer !== null) window.clearTimeout(this.timer)
    if (!query.trim()) return Promise.resolve([])
    return new Promise((resolve) => {
      this.timer = window.setTimeout(() => {
        this.vault
          .search(query.trim(), this.limit)
          .then((hits) => {
            this.lastError = null
            this.emptyStateText = 'No matching notes.'
            resolve(hits)
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            if (message !== this.lastError) new Notice(`RushDB search failed: ${message}`)
            this.lastError = message
            resolve([])
          })
      }, DEBOUNCE_MS)
    })
  }

  renderSuggestion(hit: NoteHit, el: HTMLElement) {
    el.addClass('rushdb-hit')
    el.createDiv({ cls: 'rushdb-hit-title', text: hit.title })
    if (hit.folder) el.createDiv({ cls: 'rushdb-hit-path', text: hit.folder })
    if (hit.excerpt) el.createDiv({ cls: 'rushdb-hit-excerpt', text: hit.excerpt })
  }

  onChooseSuggestion(hit: NoteHit) {
    void this.app.workspace.openLinkText(hit.path, '', false)
  }
}
