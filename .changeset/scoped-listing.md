---
'rushdb-obsidian-plugin': patch
---

A resync walks only the folders chosen for indexing instead of listing every file in the vault, so paths outside them are never read. Dev tooling no longer pulls in a `minimatch` version with a security advisory.
