# Contributing to obsidian-plugin

Use pnpm 10 and Node.js 18 or newer. Install dependencies with `pnpm install`,
then run `pnpm build`, `pnpm types:check`, `pnpm lint` and `pnpm test`.
Add a changeset for every user-facing change with `pnpm changeset`.

To try a build, link the repo into a test vault:

```bash
ln -s "$PWD" /path/to/vault/.obsidian/plugins/rushdb
pnpm dev   # rebuilds main.js on change; reload the plugin in Obsidian
```

The release workflow creates the version PR. Merging it tags the new version
(no `v` prefix, as Obsidian requires) and publishes a GitHub release with
`main.js`, `manifest.json` and `styles.css`.

`test/integration.test.ts` runs sync and the sidebar queries, plus a 1,200-note
vault, against a real server. It is skipped unless you configure one, in the
environment or in a git-ignored `.env.test`. Each run writes under its own
vault id and deletes its notes afterwards; it leaves the `NOTE` text index (and
embedding index) in place, so use a test project.

```bash
# .env.test, against RushDB Cloud (or set RUSHDB_API_URL for a self-hosted platform)
RUSHDB_API_KEY=<a test project's API key>
RUSHDB_EMBEDDINGS=1   # optional: also test semantic search
```

Or against a standalone engine:

```bash
docker run -d --rm --name plugin-test-engine -p 127.0.0.1:3997:3997 rushdb/rushdb:3.0.6 \
  --listen 0.0.0.0 --port 3997 --pgwire-port 0 --multitenant --token plugin-test
RUSHDB_ENGINE_URL=http://127.0.0.1:3997 RUSHDB_ENGINE_TOKEN=plugin-test pnpm test
docker stop plugin-test-engine
```
