# NotesVim

Vim keys for Apple Notes, using the same Vim engine as Obsidian.

Obsidian's Vim mode comes from [replit/codemirror-vim](https://github.com/replit/codemirror-vim). NotesVim runs that engine's editor-independent core (`Resources/vim.js`) inside a small menu-bar app and connects it to the Notes note body through the macOS Accessibility API. Motions, operators, text objects, counts, `.` repeat, registers, marks, macros, `:s`, `:g` and mappings therefore behave the way they do in Obsidian.

NotesVim only does anything while Notes is the frontmost app and the cursor is in a note body. Everywhere else, keys pass straight through.

https://github.com/user-attachments/assets/528a9b20-aa69-45a5-aa0d-5b1bbe79879a

## Installation

You need a Mac with the Xcode command-line tools (`xcode-select --install`), or Xcode itself.

```bash
git clone <this repo> NotesVim
cd NotesVim
make install        # builds build/NotesVim.app, copies it to /Applications, launches it
```

On first launch macOS asks for Accessibility permission. Open **System Settings → Privacy & Security → Accessibility**, switch **NotesVim** on, and NotesVim starts working within a couple of seconds. The menu bar then shows `-- NORMAL --` when you're in Notes.

**Start at login:** **System Settings → General → Login Items & Extensions**, under **Open at Login** click **+**, go to **Applications** and pick **NotesVim.app**. Always pick the one in `/Applications`, not the one in the project's `build/` folder.

### Where the app lives (two copies, on purpose)

`make install` leaves two copies of `NotesVim.app`:

| Copy | What it is |
| --- | --- |
| `/Applications/NotesVim.app` | **The real one.** Installed and running; Accessibility and Login Items point here. |
| `build/NotesVim.app` (in this folder) | A leftover from the build. It never runs by itself, and `make install` overwrites it every time. |

That's fine and not a duplicate install. Just never open the `build/` copy (double-click, or picking it in Spotlight): that would start a second NotesVim alongside the real one. `make clean` deletes it (plus the `.build` compile cache) whenever you like; the next `make install` recreates it.

### Remove completely

1. Menu bar → **Quit NotesVim** (do this first: changing Accessibility while it runs freezes the keyboard).
2. Delete `/Applications/NotesVim.app` (drag to Trash).
3. `make clean` in this folder, to delete `build/` and `.build/`.
4. **System Settings → Privacy & Security → Accessibility**: select NotesVim and click **−**.
5. **System Settings → General → Login Items & Extensions**: remove NotesVim if you added it.
6. Optional: `rm ~/.notesvimrc` and `defaults delete com.parun.NotesVim` (your mappings and menu settings).

**Signing.** The build script signs with your *Apple Development* certificate if it finds one. Xcode creates it when you pick your Apple ID as a signing team. With that certificate, macOS remembers the Accessibility permission across rebuilds. Without it, the app is signed ad-hoc and you need to switch the permission off and on again after every rebuild. To choose a certificate explicitly, set `NOTESVIM_SIGN_IDENTITY`.

## Updating

After changing any code (`Sources/`, `Resources/`), run this in the project folder:

```bash
make install
```

That's all. It rebuilds, quits the running NotesVim, replaces `/Applications/NotesVim.app` and relaunches it. Don't touch the Accessibility setting: the app is signed with my Apple Development certificate, so macOS keeps the permission.

Only `~/.notesvimrc` changes skip the rebuild: use **Reload ~/.notesvimrc** in the menu bar.

**If the menu bar shows `VIM ⚠︎` after an update** (permission lost):

1. Quit NotesVim first (menu bar → **Quit NotesVim**). Toggling Accessibility while it's running freezes the keyboard.
2. **System Settings → Privacy & Security → Accessibility**: switch **NotesVim** off, then on.
3. `open /Applications/NotesVim.app`

## Use

- Notes opens in **normal mode**, like a file in Obsidian. Press `i`, `a`, `o` and so on to type, and `Esc` (or `Ctrl-[` / `Ctrl-c`) to go back.
- **Insert mode is plain Notes.** Every key behaves exactly as it does without NotesVim (Ctrl-D, Ctrl-T, Ctrl-O, Option-arrows…). Only `Esc`, `Ctrl-[`, `Ctrl-c` and your own `imap`s go to Vim. Vim's insert-mode commands (`Ctrl-w`, `Ctrl-u`, `Ctrl-o`, `Ctrl-r`…) are not used.
- **⌘ shortcuts always go to Notes** (⌘C, ⌘V, ⌘B, ⌘Z…), in every mode.
- `u` and `Ctrl-r` use Notes' own undo history (Edit → Undo / Redo).
- `:` and `/` open a small command bar at the bottom of the Notes window. Just type: Notes keeps focus and your keys go into the bar, never the note. Enter runs, Esc (or Backspace on an empty bar) cancels, `↑`/`↓` go through history, `Ctrl-u`/`Ctrl-w` delete, ⌘V pastes.
- While recording a macro, the menu bar shows `recording @a`.
- `"+y` and `"+p` use the system clipboard. Other registers stay inside Vim, as in Obsidian. NotesVim never touches the clipboard otherwise.
- In normal mode, the cursor is drawn as a one-character selection, standing in for Vim's block cursor. You can turn this off in the menu.

### Menu bar

| Item | What it does |
| --- | --- |
| `-- NORMAL --` / `-- INSERT --` / … | Current mode while Notes is in front; `VIM` otherwise |
| Enabled | Turn NotesVim off without quitting |
| Block cursor in normal mode | Draw the cursor as a one-character selection |
| Edit / Reload `~/.notesvimrc` | Your mappings and settings |

### `~/.notesvimrc`

This file uses the same syntax as Obsidian's `.obsidian.vimrc`. Each line runs as a Vim ex command at startup:

```vim
" leave insert mode with jk
imap jk <Esc>
" move by screen lines
nmap j gj
nmap k gk
```

To use your Obsidian settings as they are, symlink the file: `ln -s /path/to/vault/.obsidian.vimrc ~/.notesvimrc`. Lines that call Obsidian commands (`exmap`, `obcommand`, `jscommand`) are skipped, and mappings that use them won't do anything.

## Differences from Obsidian

These come from Notes being a rich-text app with a single caret:

- **Visual block (`Ctrl-v`)** edits every line, but Notes can only highlight one range, so you only see the first line selected.
- **No search highlighting**, and `/` doesn't jump while you type. It moves on Enter.
- **Scrolling commands** (`zz`, `zt`, `Ctrl-d`, `Ctrl-u`, `H`, `M`, `L`) are approximate, because Notes has no fixed line grid. They work from the lines currently visible.
- **Checklist boxes, tables and images** each count as one character, so motions treat them like a single symbol.
- **Undo** steps follow Notes' history, which can group edits differently than Obsidian.
- **`:w`** does nothing. Notes saves automatically.

## How it works

```
key press ─▶ event tap (KeyTap.swift)
              │  Notes frontmost and a note body focused?
              ▼
         VimEngine.swift ── JavaScriptCore ──▶ notes-adapter.js ──▶ vim.js (Obsidian's engine)
                                                  │
                                       reads/writes through `native`
                                                  ▼
                                   NotesBridge.swift ── Accessibility API ──▶ Notes
```

- `notes-adapter.js` implements the editor interface the engine expects. It's modelled on the CodeMirror 6 adapter that Obsidian uses, over a plain-text copy of the note. Before each key it reads the note's text and selection from Notes; typing done in insert mode is picked up as a change, so `.` and macros can repeat it.
- Edits are made by selecting a range and replacing the selected text through Accessibility, so formatting outside the edit is preserved.
- In insert mode, every key except the ones that leave it goes to Notes untouched. If Notes refuses an Accessibility edit, NotesVim types the text as key presses instead (never via the clipboard), and shows a warning in the menu until the next edit succeeds. In normal and visual mode nothing reaches the note, the same as Obsidian.

## Development

```bash
make test   # behaviour tests: the real engine + adapter + a fake Notes (needs Node)
make run    # run from the terminal (Accessibility permission then goes to your terminal app)
make app    # build build/NotesVim.app without installing
```

`tests/harness.js` loads `vim.js` and the adapter into a sandbox with a fake Notes text view, so all the Vim behaviour can be tested without a Mac.

To update the engine, replace `Resources/vim.js` with `packages/codemirror-vim-core/vim.js` from [replit/codemirror-vim](https://github.com/replit/codemirror-vim) and run `make test`. The bundled copy is from commit `8640966`.

## Licence

MIT. `Resources/vim.js` is from replit/codemirror-vim. Copyright © 2018–2021 Marijn Haverbeke and others, MIT; see `ThirdParty/codemirror-vim-LICENSE`.
