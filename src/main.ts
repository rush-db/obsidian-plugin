import { Notice, Plugin, TFile, addIcon, debounce, type TAbstractFile } from 'obsidian'

import { RushDBVault, createDb } from './client'
import { RUSHDB_ICON, RUSHDB_ICON_SVG } from './icon'
import { RELATED_VIEW_TYPE, RelatedView } from './related-view'
import { SearchModal } from './search-modal'
import { DEFAULT_SETTINGS, collectIndexedFiles, type Credentials, type PluginData, type RushDBSettings, type SyncState } from './settings'
import { RushDBSettingTab } from './settings-tab'
import { SyncEngine, type VaultSource } from './sync'

const FLUSH_DELAY_MS = 2000

/** Secret ids used when moving credentials that 0.2 and earlier kept in plugin data. */
const LEGACY_SECRET_IDS = { apiKey: 'rushdb-api-key', engineToken: 'rushdb-engine-token' } as const

/** The settings that decide where notes go and which ones; a change triggers a resync. */
const syncKey = (s: RushDBSettings, c: Credentials) =>
  JSON.stringify([s.mode, s.apiUrl, c.apiKey, s.engineUrl, c.engineToken, s.engineScope, s.includeFolders, s.excludeFolders, s.embeddings, s.maxBodyChars])

export default class RushDBPlugin extends Plugin {
  settings: RushDBSettings = { ...DEFAULT_SETTINGS }
  private state: SyncState = { vaultId: '', notes: {} }
  private vault: RushDBVault | null = null
  private sync: SyncEngine | null = null
  private appliedKey = ''
  private statusEl: HTMLElement | null = null

  async onload() {
    await this.loadPluginData()

    this.addSettingTab(new RushDBSettingTab(this.app, this))
    this.statusEl = this.addStatusBarItem()

    addIcon(RUSHDB_ICON, RUSHDB_ICON_SVG)
    this.registerView(
      RELATED_VIEW_TYPE,
      (leaf) => new RelatedView(leaf, () => this.vault, (path) => this.sync?.isIndexed(path) ?? false)
    )

    this.addCommand({
      id: 'search',
      name: 'Search notes',
      callback: () => {
        if (!this.vault) return void new Notice('Connect RushDB in the plugin settings first.')
        new SearchModal(this.app, this.vault).open()
      }
    })
    this.addCommand({
      id: 'open-related',
      name: 'Show related notes',
      callback: () => void this.openRelated()
    })
    this.addCommand({
      id: 'resync',
      name: 'Resync the vault',
      callback: () => void this.resync()
    })

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.metadataCache.on('changed', (file) => this.onChanged(file)))
      this.registerEvent(this.app.vault.on('delete', (file) => this.onDeleted(file)))
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => void this.onRenamed(file, oldPath)))
      void this.connect()
    })
  }

  onunload() {
    void this.sync?.flush()
  }

  async saveSettings() {
    await this.savePluginData()
  }

  /** Applies settings changes made in the tab: reconnects and resyncs when they matter. */
  async onSettingsClosed() {
    if (syncKey(this.settings, this.credentials()) !== this.appliedKey) await this.connect()
  }

  async checkConnection() {
    if (!this.vault) await this.connect()
    if (!this.vault) throw new Error('fill in the connection settings first')
    const notes = await this.vault.listNotes(this.state.vaultId)
    return notes.length
  }

  async resync() {
    if (!this.sync) return void new Notice('Connect RushDB in the plugin settings first.')
    try {
      await this.sync.reconcile()
      new Notice(`RushDB: ${Object.keys(this.state.notes).length} notes indexed.`)
    } catch (error) {
      this.reportError(error)
    }
  }

  async purge() {
    if (!this.vault) await this.connect()
    if (!this.vault) throw new Error('fill in the connection settings first')
    const count = await this.vault.purgeVault()
    this.state.notes = {}
    await this.savePluginData()
    this.setStatus(null)
    return count
  }

  /** The API key and engine token, read from Obsidian's secret storage. */
  private credentials(): Credentials {
    const read = (id: string) => (id ? (this.app.secretStorage.getSecret(id) ?? '') : '')
    return { apiKey: read(this.settings.apiKeySecret), engineToken: read(this.settings.engineTokenSecret) }
  }

  private async connect() {
    const credentials = this.credentials()
    this.appliedKey = syncKey(this.settings, credentials)
    this.vault = null
    this.sync = null
    const configured =
      this.settings.mode === 'api' ? !!this.settings.apiUrl && !!credentials.apiKey : !!this.settings.engineUrl
    if (!configured) return this.setStatus('not connected')

    const vault = new RushDBVault(createDb(this.settings, credentials), this.state.vaultId, this.settings)
    this.vault = vault
    this.sync = new SyncEngine(
      this.vaultSource(),
      vault,
      () => this.settings,
      this.state,
      () => this.savePluginData(),
      (progress) =>
        this.setStatus(
          progress ? `${progress.phase === 'notes' ? 'syncing notes' : 'linking'} ${progress.done}/${progress.total}` : null
        )
    )
    this.refreshRelatedViews()
    if (!this.settings.includeFolders.length) return this.setStatus('no folders chosen')

    try {
      await vault.ensureIndexes()
      await this.sync.reconcile()
    } catch (error) {
      this.reportError(error)
    }
  }

  private scheduleFlush = debounce(
    () => {
      this.sync?.flush().catch((error: unknown) => this.reportError(error))
    },
    FLUSH_DELAY_MS,
    true
  )

  private onChanged(file: TFile) {
    if (!this.sync || file.extension !== 'md') return
    if (!this.sync.isIndexed(file.path) && !this.state.notes[file.path]) return
    this.sync.enqueue(file.path)
    this.scheduleFlush()
  }

  private onDeleted(file: TAbstractFile) {
    if (!this.sync || !(file instanceof TFile)) return
    this.sync.enqueueDelete(file.path)
    this.scheduleFlush()
  }

  private async onRenamed(file: TAbstractFile, oldPath: string) {
    if (!this.sync || !(file instanceof TFile) || file.extension !== 'md') return
    if (!this.state.notes[oldPath] && !this.sync.isIndexed(file.path)) return
    try {
      await this.sync.rename(oldPath, file.path)
    } catch (error) {
      this.reportError(error)
    }
  }

  private vaultSource(): VaultSource {
    const { vault, metadataCache } = this.app
    const fileAt = (path: string) => {
      const file = vault.getAbstractFileByPath(path)
      return file instanceof TFile ? file : null
    }
    return {
      indexedFiles: () => this.indexedFiles().map((f) => ({ path: f.path, basename: f.basename, mtime: f.stat.mtime })),
      file: (path) => {
        const f = fileAt(path)
        return f ? { path: f.path, basename: f.basename, mtime: f.stat.mtime } : null
      },
      read: async (path) => {
        const f = fileAt(path)
        if (!f) throw new Error(`${path} no longer exists`)
        return vault.cachedRead(f)
      },
      metadata: (path) => {
        const f = fileAt(path)
        return f ? metadataCache.getFileCache(f) : null
      },
      resolvedLinks: () => metadataCache.resolvedLinks
    }
  }

  private indexedFiles(): TFile[] {
    const { vault } = this.app
    return collectIndexedFiles<TFile>(this.settings, (path) => (path === '' ? vault.getRoot() : vault.getFolderByPath(path)))
  }

  private async openRelated() {
    const existing = this.app.workspace.getLeavesOfType(RELATED_VIEW_TYPE)[0]
    const leaf = existing ?? this.app.workspace.getRightLeaf(false)
    if (!leaf) return
    if (!existing) await leaf.setViewState({ type: RELATED_VIEW_TYPE, active: true })
    await this.app.workspace.revealLeaf(leaf)
  }

  private refreshRelatedViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(RELATED_VIEW_TYPE)) {
      if (leaf.view instanceof RelatedView) void leaf.view.refresh(true)
    }
  }

  private setStatus(text: string | null) {
    if (!this.statusEl) return
    const indexed = Object.keys(this.state.notes).length
    this.statusEl.setText(`RushDB: ${text ?? `${indexed} notes`}`)
  }

  private reportError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    this.setStatus('sync failed')
    new Notice(`RushDB sync failed: ${message}`)
  }

  private async loadPluginData() {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData> & {
      settings?: Partial<RushDBSettings> & { apiKey?: string; engineToken?: string }
    }
    const saved: Partial<RushDBSettings> & { apiKey?: string; engineToken?: string } = data.settings ?? {}
    const { apiKey, engineToken, ...stored } = saved
    // Secret ids start empty here so the 0.2 migration below can claim them; unset ones then get the default.
    // A saved folder list is kept as it is, even an empty one: only a new install starts with the whole vault.
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      apiKeySecret: stored.apiKeySecret ?? '',
      engineTokenSecret: stored.engineTokenSecret ?? ''
    }
    this.state = {
      vaultId: data.state?.vaultId || crypto.randomUUID(),
      notes: data.state?.notes ?? {}
    }
    // 0.2 and earlier kept credentials in plugin data: move them to secret storage.
    this.moveToSecretStorage('apiKeySecret', LEGACY_SECRET_IDS.apiKey, apiKey)
    this.moveToSecretStorage('engineTokenSecret', LEGACY_SECRET_IDS.engineToken, engineToken)
    this.settings.apiKeySecret ||= DEFAULT_SETTINGS.apiKeySecret
    this.settings.engineTokenSecret ||= DEFAULT_SETTINGS.engineTokenSecret
    // Saving also drops the plaintext fields from data.json.
    if (!data.state?.vaultId || apiKey !== undefined || engineToken !== undefined) await this.savePluginData()
  }

  private moveToSecretStorage(setting: 'apiKeySecret' | 'engineTokenSecret', id: string, value: string | undefined) {
    if (!value || this.settings[setting]) return
    if (!this.app.secretStorage.getSecret(id)) this.app.secretStorage.setSecret(id, value)
    this.settings[setting] = id
  }

  private async savePluginData() {
    await this.saveData({ settings: this.settings, state: this.state } satisfies PluginData)
  }
}
