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

`test/engine.test.ts` runs sync and the sidebar queries against a real engine
and is skipped unless you point it at one. Each run uses its own tenant and
deletes its notes afterwards:

```bash
docker run -d --rm --name plugin-test-engine -p 127.0.0.1:3997:3997 rushdb/rushdb:3.0.6 \
  --listen 0.0.0.0 --port 3997 --pgwire-port 0 --multitenant --token plugin-test
RUSHDB_ENGINE_URL=http://127.0.0.1:3997 RUSHDB_ENGINE_TOKEN=plugin-test pnpm test
docker stop plugin-test-engine
```
