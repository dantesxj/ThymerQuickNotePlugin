# ThymerQuickNotePlugin

Create notes in configured collections with prompted fields, tokenized titles, and optional body templates.

‼️ In progress. Created by AI, vibes, and someone who knows nothing about coding! Suggestions and support very welcome! ‼️

## Features

- Quick note creation from sidebar button and command palette.
- Customizable title templates with tokens:
  - `{Date}`, `{Time}`, `{Collection}`, and prompted field tokens.
- Prompted field types:
  - text
  - choice
  - reference (including multi-reference selection)
  - date/datetime prompt flow
- Body templates copied from `Quick Note Templates` collection records.
- Manual template insertion into the current record:
  - Command Palette -> `Insert Template Here`
- Export/import plugin configuration.
- Automatic field population and token substitution in title + template content.

## Storage mode

Includes Path B storage support (**Plugin Backend** collection + localStorage mirror; legacy **Plugin Settings** name still resolved):

- Command Palette: `Quick Note: Storage location…`
- Can switch between local-only and synced settings.

## UI updates in this sync

- Added frosted prompt styling for input/date dialogs.
- Expanded date prompt behavior with optional "include time" defaults.
- Improved template and field-configuration controls in settings.

## Setup

Create a collection named:

- `Quick Note Templates`

Template records in that collection become selectable for per-collection auto-fill templates.

## Files

- `plugin.js` - plugin code
- `plugin.json` - plugin metadata
