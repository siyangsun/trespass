# trespass

A spreadsheet editor for Godot `.tres` resource files. Pick a resource class, edit every instance in a grid, and write only the lines you changed back to disk.

## Run

```
npm install
npm start path/to/godot/project    # or any folder of .tres files; defaults to .
```

Opens http://localhost:4173 (set `PORT` to change it, `NO_OPEN=1` to skip opening the browser). Try it on the bundled sample: `npm start example`.

Needs a Node version that runs `.ts` files directly.

## Features

- One grid per resource class, with columns taken from the `@export` vars in the `.gd` script (enums, defaults and inherited exports included).
- Typed, validated edits: ints, floats, bools, strings, colors, vectors, enum dropdowns. Image refs show thumbnails.
- Copy/paste ranges, fill down, formula on selected numbers (`v * 1.15`), undo/redo (Ctrl/Cmd+Z).
- CSV export and import.
- Duplicate a file, create a new one at script defaults, or delete (moves to `.trespass-trash/`).
- Find/replace across every property of every class.
- Warnings (⚠) for missing `res://` files and duplicate `id`/`name` values.
- Save shows a line diff first, writes only touched lines, and refuses files that changed on disk since loading. External changes reload live.
- Filter (`tier >= 3`, or plain text), folder picker, hideable columns; filter and hidden columns are remembered per class.

## Develop

```
npm test         # round-trip and parser tests
npm run check    # tsc --noEmit
```

Layout: `trespass.ts` (server), `server/` (`.tres` and `.gd` parsing), `shared/` (value model, formulas), `web/` (UI, Tabulator from a CDN).
