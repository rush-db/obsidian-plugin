// Plugin code uses `window` timers (popout-safe in Obsidian); Node has the same ones globally.
;(globalThis as { window?: unknown }).window ??= globalThis
