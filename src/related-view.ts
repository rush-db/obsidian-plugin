import { ItemView, TFile, WorkspaceLeaf, debounce, getAllTags } from 'obsidian'

import type { NoteHit, RelatedNotes, RushDBVault } from './client'

export const RELATED_VIEW_TYPE = 'rushdb-related'

const SECTIONS: Array<{ key: keyof RelatedNotes; title: string; empty: string }> = [
  { key: 'outgoing', title: 'Links', empty: 'No links to indexed notes.' },
  { key: 'backlinks', title: 'Backlinks', empty: 'No indexed note links here.' },
  { key: 'twoHops', title: 'Two links away', empty: 'Nothing two links away.' },
  { key: 'similar', title: 'Similar notes', empty: 'No similar notes found.' },
  { key: 'sharedTags', title: 'Shared tags', empty: 'No other notes share its tags.' }
]

/** Notes connected to the active note: links, backlinks, two-hop neighbours, similar and same-tag notes. */
export class RelatedView extends ItemView {
  private current: string | null = null
  private generation = 0

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getVault: () => RushDBVault | null,
    private readonly isIndexed: (path: string) => boolean
  ) {
    super(leaf)
  }

  getViewType() {
    return RELATED_VIEW_TYPE
  }

  getDisplayText() {
    return 'Related notes'
  }

  getIcon() {
    return 'network'
  }

  async onOpen() {
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleRefresh()))
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (file.path === this.current) this.scheduleRefresh()
      })
    )
    await this.refresh()
  }

  private scheduleRefresh = debounce(() => void this.refresh(), 600, true)

  async refresh(force = false) {
    const file = this.app.workspace.getActiveFile()
    const container = this.contentEl
    if (!force && file?.path === this.current && container.childElementCount > 0) return
    this.current = file?.path ?? null
    const generation = ++this.generation

    container.empty()
    container.addClass('rushdb-related')

    const vault = this.getVault()
    if (!vault) return this.message('Connect RushDB in the plugin settings to see related notes.')
    if (!file || file.extension !== 'md') return this.message('Open a note to see what it connects to.')
    if (!this.isIndexed(file.path)) return this.message('This note is outside the indexed folders.')

    this.message('Loading…')
    try {
      const related = await vault.related(await this.describe(file))
      if (generation !== this.generation) return
      container.empty()
      for (const section of SECTIONS) this.renderSection(section.title, related[section.key], section.empty)
    } catch (error) {
      if (generation !== this.generation) return
      container.empty()
      this.message(`Could not load related notes: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async describe(file: TFile) {
    const cache = this.app.metadataCache.getFileCache(file)
    return {
      path: file.path,
      title: file.basename,
      headings: (cache?.headings ?? []).map((h) => h.heading),
      tags: cache ? (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, '')) : [],
      text: await this.app.vault.cachedRead(file)
    }
  }

  private message(text: string) {
    this.contentEl.empty()
    this.contentEl.createDiv({ cls: 'rushdb-related-message', text })
  }

  private renderSection(title: string, hits: NoteHit[], empty: string) {
    const section = this.contentEl.createDiv({ cls: 'rushdb-related-section' })
    section.createDiv({ cls: 'rushdb-related-heading', text: `${title} (${hits.length})` })
    if (!hits.length) {
      section.createDiv({ cls: 'rushdb-related-empty', text: empty })
      return
    }
    const list = section.createEl('ul', { cls: 'rushdb-related-list' })
    for (const hit of hits) {
      const item = list.createEl('li')
      const link = item.createEl('a', { cls: 'rushdb-related-link', text: hit.title, href: '#' })
      link.addEventListener('click', (event) => {
        event.preventDefault()
        void this.app.workspace.openLinkText(hit.path, '', event.metaKey || event.ctrlKey)
      })
      if (hit.folder) item.createSpan({ cls: 'rushdb-related-folder', text: hit.folder })
    }
  }
}
