import { App, Notice, PluginSettingTab, type SettingDefinitionItem } from 'obsidian'

import type RushDBPlugin from './main'
import { parseFolderList, type RushDBSettings } from './settings'

type Key = keyof RushDBSettings

/** Folder lists are edited as one folder per line. */
const FOLDER_LISTS = new Set<Key>(['includeFolders', 'excludeFolders'])

export class RushDBSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: RushDBPlugin
  ) {
    super(app, plugin)
  }

  getSettingDefinitions(): SettingDefinitionItem<Key>[] {
    const settings = this.plugin.settings
    const isApi = () => settings.mode === 'api'

    return [
      {
        type: 'group',
        heading: 'Connection',
        items: [
          {
            name: 'Server',
            desc: 'RushDB Cloud or a self-hosted platform use an API key. A standalone engine is reached directly.',
            control: {
              type: 'dropdown',
              key: 'mode',
              options: { api: 'RushDB API (Cloud or self-hosted)', engine: 'Standalone engine' }
            }
          },
          {
            name: 'API URL',
            desc: 'https://api.rushdb.com for RushDB Cloud, or your own platform URL.',
            visible: isApi,
            control: { type: 'text', key: 'apiUrl', placeholder: 'https://api.rushdb.com' }
          },
          {
            name: 'API key',
            desc: 'A project API key, kept in Obsidian’s secret storage.',
            visible: isApi,
            control: { type: 'secret', key: 'apiKeySecret' }
          },
          {
            name: 'Engine URL',
            desc: 'Where `rushdb serve` listens, for example http://127.0.0.1:3999.',
            visible: () => !isApi(),
            control: { type: 'text', key: 'engineUrl', placeholder: 'http://127.0.0.1:3999' }
          },
          {
            name: 'Engine token',
            desc: 'Leave empty if the engine runs without a token.',
            visible: () => !isApi(),
            control: { type: 'secret', key: 'engineTokenSecret' }
          },
          {
            name: 'Tenant',
            desc: 'For an engine started with --multitenant; leave empty otherwise.',
            visible: () => !isApi(),
            control: { type: 'text', key: 'engineScope' }
          },
          {
            name: 'Check connection',
            render: (setting) => {
              setting.addButton((button) =>
                button.setButtonText('Check').onClick(async () => {
                  button.setDisabled(true)
                  try {
                    const count = await this.plugin.checkConnection()
                    new Notice(`Connected to RushDB. ${count} notes of this vault are indexed.`)
                  } catch (error) {
                    new Notice(`Could not connect: ${error instanceof Error ? error.message : String(error)}`)
                  } finally {
                    button.setDisabled(false)
                  }
                })
              )
            }
          }
        ]
      },
      {
        type: 'group',
        heading: 'Index',
        items: [
          {
            name: 'Folders to index',
            desc: 'One per line; / for the whole vault. Notes are sent to the server above only from these folders, and nothing is sent until you choose one. Changes apply when you close the settings.',
            aliases: ['privacy', 'include'],
            control: { type: 'textarea', key: 'includeFolders', placeholder: '/', rows: 4 }
          },
          {
            name: 'Folders to skip',
            desc: 'One per line, inside the indexed folders: journals, private notes, templates.',
            aliases: ['exclude', 'ignore'],
            control: { type: 'textarea', key: 'excludeFolders', rows: 3 }
          },
          {
            name: 'Semantic search',
            desc: 'Embed note text with the server’s managed embedding model for similarity search. Needs RushDB Cloud or a platform with an embedding model; a standalone engine uses keyword search only.',
            aliases: ['embeddings', 'vector'],
            control: { type: 'toggle', key: 'embeddings', disabled: () => !isApi() }
          },
          {
            name: 'Text per note',
            desc: 'Characters of each note sent for search. Longer notes are cut.',
            control: {
              type: 'number',
              key: 'maxBodyChars',
              min: 1,
              validate: (value) => (Number.isInteger(value) && value > 0 ? undefined : 'Enter a whole number above 0.')
            }
          }
        ]
      },
      {
        type: 'group',
        heading: 'Maintenance',
        items: [
          {
            name: 'Resync',
            desc: 'Compare the vault with RushDB and send whatever differs.',
            render: (setting) => {
              setting.addButton((button) => button.setButtonText('Resync').onClick(() => void this.plugin.resync()))
            }
          },
          {
            name: 'Remove this vault from RushDB',
            desc: 'Deletes every note and link this vault sent. Your notes are not touched.',
            render: (setting) => {
              setting.addButton((button) =>
                button
                  .setButtonText('Remove')
                  .setDestructive()
                  .onClick(async () => {
                    button.setDisabled(true)
                    try {
                      const count = await this.plugin.purge()
                      new Notice(`Removed ${count} notes from RushDB.`)
                    } catch (error) {
                      new Notice(`Could not remove: ${error instanceof Error ? error.message : String(error)}`)
                    } finally {
                      button.setDisabled(false)
                    }
                  })
              )
            }
          }
        ]
      }
    ]
  }

  getControlValue(key: string): unknown {
    const value = this.plugin.settings[key as Key]
    return FOLDER_LISTS.has(key as Key) && Array.isArray(value) ? value.join('\n') : value
  }

  /** Writes into the settings and saves them with the sync state, which share plugin data. */
  async setControlValue(key: string, value: unknown) {
    const settings = this.plugin.settings as unknown as Record<string, unknown>
    settings[key] = FOLDER_LISTS.has(key as Key) ? parseFolderList(String(value)) : value
    await this.plugin.saveSettings()
    // The server choice decides which connection rows show.
    if (key === 'mode') this.refreshDomState()
  }

  hide() {
    super.hide()
    void this.plugin.onSettingsClosed()
  }
}
