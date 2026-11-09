# RushDB for Obsidian

Index your vault into [RushDB](https://rushdb.com) and turn your notes into a graph you and your AI agents can search and traverse.

- **Sync**: notes, properties (frontmatter), tags, headings and `[[links]]` become RushDB records and `LINKS_TO` relationships. Changes, renames and deletions follow in seconds.
- **Search**: keyword (BM25) search over your notes, or hybrid keyword + semantic search with embeddings turned on.
- **Related notes**: a sidebar for the open note with its links, backlinks, notes two links away, similar notes and notes that share its tags.
- **Agent access**: point the [RushDB MCP server](https://github.com/rush-db/mcp-server) at the same project and any MCP client can query your vault: filter by properties, follow links, search by meaning.

Your Markdown files stay the source of truth. The plugin only ever writes to RushDB, never to your vault.

## Setup

1. Install **RushDB** from **Settings → Community plugins → Browse**, then enable it.
2. Choose where your notes go, in **Settings → RushDB**:
   - **RushDB Cloud**: create a project at [app.rushdb.com](https://app.rushdb.com), create an API key and paste it. Keep the API URL as `https://api.rushdb.com`.
   - **Self-hosted platform**: set the API URL to your own RushDB platform and use one of its API keys.
   - **Standalone engine**: run `rushdb serve --port 3999` and choose **Standalone engine**. Add `--data-dir <path>` to keep the data across restarts.
3. Under **Folders to index**, list the folders to send (`/` for the whole vault) and any folders to skip. **Nothing is sent until you choose a folder.**
4. Close the settings. The first sync starts, and the status bar shows its progress.

Open the search with the **RushDB: Search notes** command and the sidebar with **RushDB: Show related notes**.

### Semantic search

With **Semantic search** on, RushDB embeds the text of each note with its managed embedding model. Search then ranks by meaning as well as keywords, and the sidebar finds similar notes by meaning. This needs RushDB Cloud, or a self-hosted platform configured with an embedding model. A standalone engine has no embedding model, so it uses keyword search only.

### Connect an AI agent

Add the RushDB MCP server to your agent with the same API key:

```json
{
  "mcpServers": {
    "rushdb": {
      "command": "npx",
      "args": ["@rushdb/mcp-server"],
      "env": { "RUSHDB_API_KEY": "<your API key>" }
    }
  }
}
```

The agent then sees your notes as `NOTE` records with `path`, `title`, `folder`, `tags`, `headings`, `body`, `modifiedAt` and your properties (prefixed `fm_`, e.g. `status` → `fm_status`), joined by `LINKS_TO` relationships. Try: *"Which notes tagged `project` link to notes that are still `fm_status: draft`?"*

## What is sent, and where

This plugin uses the network. It is clear about what it sends:

- **What**: for each note in the folders you chose, its path, title, tags, aliases, headings, properties, modification time and text (up to the limit in **Text per note**), plus the links between those notes. Notes outside those folders, attachments and other files are never sent.
- **Where**: only to the server you configure: RushDB Cloud, your own RushDB platform or your own engine.
- **Your data**: on RushDB Cloud it is stored in your project and used to answer your queries. With semantic search on, note text is embedded by the RushDB platform. See the [privacy policy](https://rushdb.com/privacy-policy).
- **Removal**: **Remove this vault from RushDB** in the settings deletes everything this vault sent.
- **Credentials**: the API key is stored in this vault's plugin data (`.obsidian/plugins/rushdb/data.json`). Leave that file out of shared or public sync.

No telemetry, no analytics and no ads. The plugin's source is in this repository, unminified in development builds.

**Account and payments**: RushDB Cloud requires an account and has a free tier and paid plans. The plugin is free, and it works fully with a self-hosted platform or a standalone engine without any account.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
