export type ConnectionMode = 'api' | 'engine'

export interface RushDBSettings {
  /** `api`: RushDB Cloud or a self-hosted platform. `engine`: a standalone `rushdb serve`. */
  mode: ConnectionMode
  /** Platform base URL, without `/api/v1`. */
  apiUrl: string
  /** Id of the API key in Obsidian's secret storage; the key itself is never in plugin data. */
  apiKeySecret: string
  /** Standalone engine base URL (direct mode). */
  engineUrl: string
  /** Id of the engine token in Obsidian's secret storage. */
  engineTokenSecret: string
  /** Tenant on a multitenant engine; empty for a single-tenant one. */
  engineScope: string
  /** Folders to index, vault-relative; `/` (the default) is the whole vault. Nothing is sent before a key is set. */
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
  apiKeySecret: 'rushdb-api-default',
  engineUrl: 'http://127.0.0.1:3999',
  engineTokenSecret: 'rushdb-engine-default',
  engineScope: '',
  includeFolders: ['/'],
  excludeFolders: [],
  embeddings: false,
  maxBodyChars: 32_000
}

/** What the plugin remembers between sessions, next to the settings. */
/** Credentials resolved from secret storage for the current connection. */
export interface Credentials {
  apiKey: string
  engineToken: string
}

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

/** The parts of Obsidian's TFolder / TFile the folder walk reads. */
export interface FolderNode {
  path: string
  children: Array<{ path: string }>
}
export interface FileNode {
  path: string
  extension: string
}

/**
 * Markdown files under the chosen folders, walking only those folders and not
 * entering skipped ones, so the rest of the vault is never listed.
 */
export const collectIndexedFiles = <F extends FileNode>(
  settings: Pick<RushDBSettings, 'includeFolders' | 'excludeFolders'>,
  folderAt: (path: string) => FolderNode | null
): F[] => {
  const skipped = new Set(settings.excludeFolders.map(normalizeFolder))
  const files = new Map<string, F>()
  const walk = (folder: FolderNode) => {
    if (skipped.has(folder.path)) return
    for (const child of folder.children) {
      if ('children' in child) walk(child as FolderNode)
      else if ('extension' in child && child.extension === 'md') files.set(child.path, child as F)
    }
  }
  for (const path of settings.includeFolders.map(normalizeFolder)) {
    const folder = folderAt(path)
    if (folder) walk(folder)
  }
  return [...files.values()]
}
