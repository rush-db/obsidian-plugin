import { ItemView, TFile, WorkspaceLeaf, debounce, getAllTags, setIcon, setTooltip } from 'obsidian'

import type { NoteHit, RelatedNotes, RushDBVault } from './client'
import { formatScore } from './format'
import { RUSHDB_ICON } from './icon'

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
    return RUSHDB_ICON
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
      for (const section of SECTIONS) this.renderSection(section, file, related[section.key])
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

  private renderSection(section: (typeof SECTIONS)[number], file: TFile, hits: NoteHit[]) {
    const el = this.contentEl.createDiv({ cls: 'rushdb-related-section' })
    const heading = el.createDiv({ cls: 'rushdb-related-heading' })
    const title = heading.createSpan()
    const refresh = heading.createDiv({ cls: 'clickable-icon rushdb-related-refresh' })
    setIcon(refresh, 'refresh-cw')
    setTooltip(refresh, `Refresh ${section.title.toLowerCase()}`)
    refresh.setAttr('aria-label', `Refresh ${section.title.toLowerCase()}`)
    refresh.setAttr('role', 'button')
    refresh.setAttr('tabindex', '0')
    const body = el.createDiv()

    const show = (list: NoteHit[]) => {
      title.setText(`${section.title} (${list.length})`)
      body.empty()
      this.renderHits(body, section, list)
    }
    const reload = async () => {
      const vault = this.getVault()
      if (!vault || refresh.hasClass('is-loading')) return
      const generation = this.generation
      refresh.addClass('is-loading')
      try {
        const list = await vault.relatedSection(section.key, await this.describe(file))
        if (generation === this.generation) show(list)
      } catch (error) {
        if (generation !== this.generation) return
        body.empty()
        body.createDiv({
          cls: 'rushdb-related-empty',
          text: `Could not load: ${error instanceof Error ? error.message : String(error)}`
        })
      } finally {
        refresh.removeClass('is-loading')
      }
    }
    refresh.addEventListener('click', () => void reload())
    refresh.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        void reload()
      }
    })
    show(hits)
  }

  private renderHits(body: HTMLElement, { key, empty }: (typeof SECTIONS)[number], hits: NoteHit[]) {
    if (!hits.length) {
      body.createDiv({ cls: 'rushdb-related-empty', text: empty })
      return
    }
    const list = body.createEl('ul', { cls: 'rushdb-related-list' })
    for (const hit of hits) {
      const item = list.createEl('li')
      const link = item.createEl('a', { cls: 'rushdb-related-link', text: hit.title, href: '#' })
      link.addEventListener('click', (event) => {
        event.preventDefault()
        void this.app.workspace.openLinkText(hit.path, '', event.metaKey || event.ctrlKey)
      })
      if (hit.folder) item.createSpan({ cls: 'rushdb-related-folder', text: hit.folder })
      if (key === 'similar' && hit.score !== undefined) {
        const badge = item.createSpan({ cls: 'rushdb-related-badge', text: formatScore(hit.score) })
        setTooltip(badge, 'Similarity to this note')
      }
      if (key === 'sharedTags' && hit.matchedTags?.length) {
        const badge = item.createSpan({ cls: 'rushdb-related-badge', text: `×${hit.matchedTags.length}` })
        setTooltip(badge, hit.matchedTags.map((tag) => `#${tag}`).join('\n'))
      }
    }
  }
}
