export type ConnectionMode = 'api' | 'engine'

export interface RushDBSettings {
  /** `api`: RushDB Cloud or a self-hosted platform. `engine`: a standalone `rushdb serve`. */
  mode: ConnectionMode
  /** Platform base URL, without `/api/v1`. */
  apiUrl: string
  apiKey: string
  /** Standalone engine base URL (direct mode). */
  engineUrl: string
  engineToken: string
  /** Tenant on a multitenant engine; empty for a single-tenant one. */
  engineScope: string
  /** Folders to index, vault-relative. Nothing is indexed until one is chosen; `/` means the whole vault. */
  includeFolders: string[]
  excludeFolders: string[]
  /** Managed embeddings for semantic search (RushDB Cloud or a platform with an embedding model). */
  embeddings: boolean
  /** Characters of note text sent per note. */
  maxBodyChars: number
}

export const DEFAULT_SETTINGS: RushDBSettings = {
  mode: 'api',
  apiUrl: 'https://api.rushdb.com',
  apiKey: '',
  engineUrl: 'http://127.0.0.1:3999',
  engineToken: '',
  engineScope: '',
  includeFolders: [],
  excludeFolders: [],
  embeddings: false,
  maxBodyChars: 32_000
}

/** What the plugin remembers between sessions, next to the settings. */
export interface SyncState {
  /** Identifies this vault's records in a project shared with other vaults. */
  vaultId: string
  /** Per synced note: its record id, content hash and the paths it links to. */
  notes: Record<string, NoteState>
}

export interface NoteState {
  id: string
  hash: string
  links: string[]
  /** Set for a record adopted from RushDB: its stored links are read before they change. */
  unknownLinks?: boolean
}

export interface PluginData {
  settings: RushDBSettings
  state: SyncState
}

/** Whether a vault path falls in the folders the user chose to index. */
export const isIncluded = (path: string, settings: Pick<RushDBSettings, 'includeFolders' | 'excludeFolders'>) => {
  const within = (folder: string) => {
    const f = normalizeFolder(folder)
    return f === '' || path === f || path.startsWith(f + '/')
  }
  if (!settings.includeFolders.some(within)) return false
  return !settings.excludeFolders.some(within)
}

/** `/notes/` → `notes`, `/` → `` (the vault root). */
export const normalizeFolder = (folder: string) => folder.trim().replace(/^\/+|\/+$/g, '')

export const parseFolderList = (value: string) =>
  value
    .split(/[\n,]/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
