import { App, Notice, PluginSettingTab, Setting } from 'obsidian'

import type RushDBPlugin from './main'
import { parseFolderList, type ConnectionMode } from './settings'

export class RushDBSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: RushDBPlugin
  ) {
    super(app, plugin)
  }

  display() {
    const { containerEl } = this
    const settings = this.plugin.settings
    const save = () => this.plugin.saveSettings()
    containerEl.empty()

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Notes in the folders you choose are sent to the RushDB server configured below. Nothing is sent until you choose at least one folder.'
    })

    new Setting(containerEl).setName('Connection').setHeading()

    new Setting(containerEl)
      .setName('Server')
      .setDesc('RushDB Cloud or a self-hosted platform use an API key. A standalone engine is reached directly.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('api', 'RushDB API (Cloud or self-hosted)')
          .addOption('engine', 'Standalone engine')
          .setValue(settings.mode)
          .onChange(async (value) => {
            settings.mode = value as ConnectionMode
            await save()
            this.display()
          })
      )

    if (settings.mode === 'api') {
      new Setting(containerEl)
        .setName('API URL')
        .setDesc('https://api.rushdb.com for RushDB Cloud, or your own platform URL.')
        .addText((text) =>
          text.setValue(settings.apiUrl).onChange(async (value) => {
            settings.apiUrl = value.trim()
            await save()
          })
        )
      new Setting(containerEl)
        .setName('API key')
        .setDesc('A project API key. It is stored in this vault’s plugin data.')
        .addText((text) => {
          text.inputEl.type = 'password'
          text.setValue(settings.apiKey).onChange(async (value) => {
            settings.apiKey = value.trim()
            await save()
          })
        })
    } else {
      new Setting(containerEl)
        .setName('Engine URL')
        .setDesc('Where `rushdb serve` listens, for example http://127.0.0.1:3999.')
        .addText((text) =>
          text.setValue(settings.engineUrl).onChange(async (value) => {
            settings.engineUrl = value.trim()
            await save()
          })
        )
      new Setting(containerEl)
        .setName('Engine token')
        .setDesc('Leave empty if the engine runs without a token.')
        .addText((text) => {
          text.inputEl.type = 'password'
          text.setValue(settings.engineToken).onChange(async (value) => {
            settings.engineToken = value.trim()
            await save()
          })
        })
      new Setting(containerEl)
        .setName('Tenant')
        .setDesc('For an engine started with --multitenant; leave empty otherwise.')
        .addText((text) =>
          text.setValue(settings.engineScope).onChange(async (value) => {
            settings.engineScope = value.trim()
            await save()
          })
        )
    }

    new Setting(containerEl)
      .setName('Check connection')
      .addButton((button) =>
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

    new Setting(containerEl).setName('Index').setHeading()

    new Setting(containerEl)
      .setName('Folders to index')
      .setDesc('One per line. Use / for the whole vault. Changes apply when you close this tab.')
      .addTextArea((text) => {
        text.inputEl.rows = 4
        text.setPlaceholder('/').setValue(settings.includeFolders.join('\n')).onChange(async (value) => {
          settings.includeFolders = parseFolderList(value)
          await save()
        })
      })

    new Setting(containerEl)
      .setName('Folders to skip')
      .setDesc('One per line, inside the indexed folders: journals, private notes, templates.')
      .addTextArea((text) => {
        text.inputEl.rows = 3
        text.setValue(settings.excludeFolders.join('\n')).onChange(async (value) => {
          settings.excludeFolders = parseFolderList(value)
          await save()
        })
      })

    new Setting(containerEl)
      .setName('Semantic search')
      .setDesc(
        'Embed note text with the server’s managed embedding model for similarity search. Needs RushDB Cloud or a platform with an embedding model; a standalone engine uses keyword search only.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(settings.embeddings)
          .setDisabled(settings.mode === 'engine')
          .onChange(async (value) => {
            settings.embeddings = value
            await save()
          })
      )

    new Setting(containerEl)
      .setName('Text per note')
      .setDesc('Characters of each note sent for search. Longer notes are cut.')
      .addText((text) => {
        text.inputEl.type = 'number'
        text.setValue(String(settings.maxBodyChars)).onChange(async (value) => {
          const n = Number.parseInt(value, 10)
          if (Number.isFinite(n) && n > 0) {
            settings.maxBodyChars = n
            await save()
          }
        })
      })

    new Setting(containerEl).setName('Maintenance').setHeading()

    new Setting(containerEl)
      .setName('Resync')
      .setDesc('Compare the vault with RushDB and send whatever differs.')
      .addButton((button) => button.setButtonText('Resync').onClick(() => void this.plugin.resync()))

    new Setting(containerEl)
      .setName('Remove this vault from RushDB')
      .setDesc('Deletes every note and link this vault sent. Your notes are not touched.')
      .addButton((button) =>
        button
          .setButtonText('Remove')
          .setWarning()
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

  hide() {
    void this.plugin.onSettingsClosed()
  }
}
