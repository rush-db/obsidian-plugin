# rushdb-obsidian-plugin

## 0.2.1

### Patch Changes

- 2e50eb9: Fix the directory review: opening the related-notes view no longer relies on an API newer than the declared minimum Obsidian version (1.5.0). Releases now carry GitHub artifact attestations for `main.js`, `styles.css` and `manifest.json`, and the test toolchain is updated past its security advisories.

## 0.2.0

### Minor Changes

- 2ad86ed: Sync large vaults smoothly: notes are sent in batches of up to 100 (about 1 MB per request), deletions in bulk, and links as one request per 500 notes (each note's new `linksTo` property lists the vault-qualified keys of the notes it links to and is joined to their new `linkKey`, so links never cross vaults that share a project; link relationships carry `kind: "wikilink"`). Notes synced by 0.1.0 are re-sent once in the new format, and progress is saved after every batch so an interrupted first sync resumes where it stopped. Resyncs list only ids, paths and hashes instead of downloading every note's text, and requests are retried with backoff, which also rides out rate limits.
