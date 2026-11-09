// Copies the version changesets wrote to package.json into manifest.json and
// records it in versions.json, which Obsidian reads to pick a compatible release.
import { readFileSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'))
manifest.version = version
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n')

const versions = JSON.parse(readFileSync('versions.json', 'utf8'))
versions[version] = manifest.minAppVersion
writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n')
