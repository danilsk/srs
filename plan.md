# srs — plan

Personal spaced-repetition + dictionary app for language learning. Static site on GitHub Pages, no backend, synced via Google Drive.

## Stack

- Vanilla ES modules, no build step. `index.html` + `src/*.js`. Preact + htm from a CDN for rendering (tiny, no JSX/bundler).
- Hash router: `#/`, `#/deck/:id/learn`, `#/deck/:id/cards`, `#/deck/:id/settings`, `#/settings`. The card modal (add/edit) sits on top of any deck view or the deck list.
- Local store: IndexedDB (decks, cards, audio blobs). `localStorage` only for OpenRouter key, model names, client id.
- Deployed by pushing `main`; Pages serves the repo root.

## Data model

```
Deck {
  id, name, targetLang, nativeLang,
  steps: ["1h","1d","3d","7d","30d","3m","6m","12m"],   // last step repeats forever
  jitter: 0.15,
  newPerDay: 10,
  direction: "front" | "back" | "alt-front" | "alt-back",
  newOrder: "added" | "random" | "newest",
  reviewOrder: "due" | "random",
  mix: "new-first" | "reviews-first" | "mixed",
  senses: { min:1, max:5 }, examplesPerSense: { min:1, max:2 },
  senseFields: [{ key:"synonyms", label:"Synonyms", hint:"1-3 synonyms for this sense" },
                { key:"examples", label:"Examples", hint:"short sentences, HTML" }],
  cardFields:  [{ key:"grammar",  label:"Grammar",  hint:"gender, plural, irregular forms" }],
  llm: { prompt: "...template..." }, tts: { voice, instructions },
  updated
}
Card {
  id, deckId, front,
  senses: [{ translation, fields: { synonyms: "<html>", examples: "<html>" } }, ...],   // ordered
  fields: { grammar: "<html>", ... },                                                    // card-scoped
  // back = senses.map(s => s.translation).join(" · ")
  audio: { key, driveId } | null,
  step: -1 (new) | 0..steps.length-1,
  due, lastSide: "front"|"back", reviews, lapses,
  created, updated
}
DayCounter { deckId, date, newShown }
```

## Scheduling (deliberately simple)

- Interval of step *i* = `steps[i]` ± jitter (default 15 %, min ±10 min). Jitter makes cards added together drift apart.
- Grades on the flipped card:
  - **Again** → step 0, no due date change; the card is reinserted into the session queue at a random position within its last 30 % (min 3 cards back, or last if the queue is shorter). Repeats until graded otherwise.
  - **Stay** → same step, due = now + steps[step]
  - **Next** → step + 1 (capped at last; last step repeats with its own interval)
  - **Skip** → step + 2
- **Ruler**: every step is a button; clicking one sets `step` and `due = now + steps[step]`. `←`/`→` nudge one step, `R` resets to new. Same ruler in the card editor.
- Direction: `alt-*` flips `lastSide` on each review; `alt-front` starts new cards front-first.
- Session queue per deck: due reviews (ordered by `reviewOrder`) + new cards (ordered by `newOrder`, limited by `newPerDay − newShown today`), interleaved per `mix`. A session ends when the queue is empty, so an "Again" card is always seen again before finishing.

## OpenRouter

- Key + model names in `localStorage`. Defaults: text `openai/gpt-5.6-luna`, audio `google/gemini-3.1-flash-tts-preview`.
- Generate: one chat-completions call with `response_format: { type: "json_schema", strict: true }`. The schema is built from the deck config:
  ```
  { front_suggestion: string|null,
    senses: [ { translation, synonyms, examples } ]  // minItems/maxItems from deck, sense-scoped fields inside each item
    grammar: string }                                 // card-scoped fields at top level
  ```
  Alignment between translation *n*, synonyms *n* and examples *n* is guaranteed by the structure; the prompt only says "most common sense first, synonyms/examples must belong to their own sense". No parallel lists, nothing to parse. Front stays as typed; `front_suggestion` (typo fixed, infinitive, article) is offered with one click.
- Audio: chat-completions with `modalities:["text","audio"]`, input = front text (+ optional voice instructions). Response base64 → Blob → IndexedDB.
- The card modal is also the dictionary: typing in "front" searches the deck live; an exact match switches the modal to editing the existing card instead of generating. After "Add" the modal stays open, empty, for the next word.

## Google Drive sync

- Google Identity Services token client, scope `drive.file`. Client ID is public in the code.
- Drive folder `srs/`: `deck-<id>.json` (deck + its cards), `audio/<key>.mp3`, `lock.json`.
- **Lock**: on open, read `lock.json`. If it belongs to another client and is younger than 10 min → lock screen ("in use elsewhere · wait / take over"). Otherwise write our lock and refresh it every 2 min while the tab is visible. Release on `pagehide` / explicit "Done".
- **Pull** after acquiring the lock: download deck files whose `modifiedTime` > local. Audio downloaded lazily on first play, cached in IndexedDB.
- **Push**: debounced 5 s after any change; whole deck file overwritten (single writer → no merging). New audio uploaded right away.
- Sync status always visible in the header (synced / pushing / offline / locked).

## Screens

1. **Decks** — list with stats per deck (new today x/limit, due, total). "Add" opens the card modal for that deck, "Learn" enters it.
2. **Deck › Learn** — full-screen page without the app header (Anki-like): top bar (deck, counters, sync, Add), the card centred (tap to flip), sticky bottom bar with Show / grades, optional step ruler ("Move" toggle, remembered), tools, hotkeys behind a spoiler (hidden on touch devices).
3. **Deck › Cards** — full-width table: front, back, audio, step (inline select, due recalculated), due, next side, reviews, lapses, last review, added. Sortable headers, search, status filters, paging. Row click → edit modal. Checkbox selection → bulk bar: move to step, regenerate text/audio, delete.
4. **Card modal** — one component for add and edit. Front + Generate, generation status, suggested front, audio (play / regenerate / remove), a Senses section (ordered blocks: translation + sense fields, "+ sense") and a Card section (card fields, always last). HTML fields show a rendered preview; clicking one opens the HTML textarea (blur/Esc returns to preview). Edit mode adds the ruler, Delete, Regenerate all. A read-only **view** mode (table row click) renders the card as in Learn, with ruler, ← → through the filtered list, `E` to edit; the ✎ column opens edit directly.
5. **Deck › Settings** — languages, steps, limits, direction/order, senses range + sense fields, card fields, prompt, voice, export/delete.
6. **Settings** — OpenRouter key/models, Drive connect, sync state, export/import all.
7. **Lock screen**.

## Hotkeys

| key | learn | add / editor |
|---|---|---|
| `space` / `enter` | show answer | `enter` generate, `⌘enter` add / save |
| `1 2 3 4` | again / stay / next / skip | |
| `← →` | move card one step back / forward | same on ruler |
| `R` | reset to new | |
| `A` | play audio | |
| `E` | edit card (modal) | |
| `N` | new card (modal) | |
| `U` | undo last grade | |
| `?` | hotkey overlay | |
| `esc` | back to deck list | close modal |

## Status

Phases 1–7 implemented. Files: `index.html`, `style.css`, `src/` (app, store, db, schedule, llm, drive, audio, ui, prefs, util, views/). `blueprint.html` is the static mock the UI was reviewed on. Not done: PWA/offline manifest.

## Dev

```
./start.sh                           # serves the repo on 8123 and opens it (port: ./start.sh 9000)
node dev/cdp.mjs "http://127.0.0.1:8123/dev/test.html?wipe=yes" "#/,#/deck/{deck}/learn|space"
```
`dev/test.html` is a headless smoke test (schedule, store, UI); it wipes the local database, hence the `wipe=yes` guard. The second argument to `cdp.mjs` is an optional list of screens to screenshot.

## Deploy

Push to GitHub, enable Pages from the repo root. Then create a Google OAuth client (Web application) with the Pages origin as an authorized JavaScript origin, enable the Drive API, and paste the client ID in Settings.
