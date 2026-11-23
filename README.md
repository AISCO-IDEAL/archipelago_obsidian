# Archipelago

Write a paper in Obsidian twice over: as a **map** of claims and arguments, and as **prose**. Both are one Markdown file. The file becomes LaTeX and a PDF, with Zotero citations and two-way **Overleaf** sync.

## Install

- **Obsidian:** Settings › Community plugins › Browse › *Archipelago* (once it is listed; until then use one of the two ways below). Desktop only.
- **Before it is listed, with BRAT:** install the *BRAT* plugin, run *BRAT: Add a beta plugin for testing*, enter `AISCO-IDEAL/archipelago_obsidian`, then enable *Archipelago*. BRAT also installs later releases.
- **Before it is listed, by hand:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/AISCO-IDEAL/archipelago_obsidian/releases/latest) into `<vault>/.obsidian/plugins/archipelago/` (create the folder), restart Obsidian, and enable *Archipelago* under Settings › Community plugins. Updates are done the same way.
- **Before it is listed, from source:** `git@github.com:AISCO-IDEAL/archipelago_obsidian.git`, then `cd archipelago_obsidian` and `node build.js --install <vault>` (Node 22) builds the plugin and copies it into `<vault>/.obsidian/plugins/archipelago/`. Restart Obsidian and enable *Archipelago*. After a `git pull`, run it again. It does not touch the plugin's `data.json`.
- **PDF:** Nothing to install. The first time you compile, the PDF view offers to download Archipelago's LaTeX engine, [Tectonic](https://tectonic-typesetting.github.io) 0.17.0 (one program, about 10 to 20 MB, checked against its SHA-256). It fetches the LaTeX packages a document needs from a fixed TeX Live snapshot, so everyone gets the same PDF. The first PDF needs the internet and takes longer.
- **Overleaf sync:** You need an Overleaf plan with Git integration and `git` (the Flatpak includes it). Paste a Git token (Overleaf › Account settings › Git integration) into Settings › Archipelago.

## Features

- **Map:** islands (sections), claim cards, links (`needs`), notes, nested subsections down to LaTeX's depth, and figure, table and equation cards. Click the label of a subsection to select it: Delete removes it with its contents, Ctrl+Shift+G removes only the subsection and keeps its contents, a double click renames it.
- **Blocks in or out of the paper:** every island and every free-floating figure, table or equation has a switch. One that is off is not in Prose or in the LaTeX, and not in the section numbers. Of an island that is off, only the claims that a claim of a block that is on depends on (`needs`) stay, each below the claim that needs it in Prose (marked with where it comes from). The switches are saved in the note's front matter (`inactive: s2, c10`), so every plugin version leaves them alone, and what is off is never emptied by an edit of the `.tex`.
- **Images:** drop image files on the Map, or paste them (Ctrl+V; a screenshot, an image copied from a browser) on the Map or in Prose. They go into the document's `figures/`. A clipboard with text pastes the text.
- **Prose:** one text field for each section and subsection, however many claims it has: the claims are a list beside it (↑ ↓ move a claim, ↳ makes a subsection of it), the text is yours to write, and a blank line starts a new paragraph. All of it is in the PDF. In the file the text is the paragraphs right under the heading, without a claim; a document that still has prose in its claims is brought to this form when it is opened (the next autosave writes it). Numbered headings, styles (bold, italic, strikethrough, highlight, colour, comment) via the context menu or shortcuts, link suggestions.
- **LaTeX / PDF:**
  - Templates live in `<Archipelago folder>/latex_templates/`.
  - Each document has a folder with `figures/` and `.bib`, and, once it has been synced with Overleaf or zipped, the `.tex`. The folder is a complete project that Overleaf can compile.
  - The LaTeX view can be edited. *Apply* takes the edits back into the document.
  - **Making a PDF writes nothing into the vault.** It is made in a cache on this computer (`~/.cache/archipelago-latex/`), with the entries of the library that the folder's `.bib` still lacks. So two people making a PDF never conflict over files that Overleaf and the sync tool carry. The `.tex`, the missing `.bib` entries, images from elsewhere and a `latexmkrc` are written into the document's folder when the project is synced with Overleaf or zipped. A copy of the PDF goes into the folder only on request (`⋯` › *Save a copy of the PDF*). To work on the folder with other tools (`latexmk`, an editor) without syncing first, use `⋯` › *Write the project files into the folder* (also a command).
  - The document's template (`latex:` in its front matter) makes the `.tex` that goes to Overleaf. In the PDF view, each computer may preview with another template: that choice stays on the computer, and neither the note nor the `.tex` changes. *Make it the document's template…* (after a confirmation) changes the note, so everyone gets that template and the next Overleaf sync brings its preamble there.
  - With Tectonic, the folder gets a `latexmkrc` that makes Overleaf compile with XeLaTeX too (Tectonic is XeTeX), so both PDFs are set alike. Delete it to use Overleaf's menu again; it is written again only while it is missing.
- **Citations:** `[@key]`, or links to Zotero/ZotFlow literature notes. Entries go into the document's `.bib` automatically. Claims about a paper cite it at the end of their subsection and of the linked ones.
- **Overleaf:**
  - Zip export for upload.
  - Two-way Git sync, by hand or as auto-sync every N minutes for each note.
  - Overleaf's edits come back into the document: text, headings, captions, tables, equations, title, author and date.
  - A changed preamble can be kept as the document's template.
  - Conflicts ask.
- **The way back:** a `.tex` edited elsewhere can be taken over. LaTeX that has no Markdown form stays raw LaTeX, so nothing is lost.

## Limitations

- **Not taken over from LaTeX:** claims, links and map positions (they are not in the `.tex`), heading-level changes, and removed headings or blocks.
- **Overleaf:** comments and tracked changes are not part of its Git data, so they do not sync.
- **Auto-sync:** it only runs while the note is open, and it pauses when a decision is needed.
- **Desktop only.**

## Privacy

- **Network:** Overleaf sync goes to `git.overleaf.com`; the token is sent only there. With Tectonic as the engine: its download from `github.com` (once, when you ask for it), and Tectonic itself fetches LaTeX packages from its bundle server when a document first needs them. Nothing about your documents is sent.
- **Token:** stored in Obsidian's secret storage, the system keychain, from Obsidian 1.11.4. Older versions store it in plain text in the plugin settings.
- **Programs it starts:** Tectonic (the downloaded program) and `git`.
- **Files outside the vault:** LaTeX build files go in `~/.cache/archipelago-latex/`, Overleaf working copies in `~/.cache/archipelago-overleaf/`, Tectonic and the packages it fetched in `~/.cache/archipelago-tectonic/`. The preview template of each document is kept in Obsidian's local storage of this computer.
- **Other plugins:** it reads Completr's word list, if Completr is installed, to make suggestions.

## How documents open

A document is a Markdown file, and Obsidian has no API to give a view to some `.md` files and not others. So the plugin wraps `WorkspaceLeaf.prototype.setViewState`: when a file starts with the Archipelago format line, the tab gets this plugin's view instead of the note editor. Only that line decides, nothing else about the leaf is changed, and any failure opens the file as a normal note. "Open as Markdown" is in the view's menu. The wrapper is removed when the plugin is disabled, or switches itself off if another plugin has patched on top of it.

## Planned

AI help for templates and compile errors, collapse and drag of subsections, and Overleaf comments.

## Development

The document model and the LaTeX export and import (`src/core.js`, `latex.js`, `fromlatex.js`, `richtext.js`) are plain UMD modules that do not depend on Obsidian, and `npm test` tests them on their own. They live only in this repository.

`npm test` runs the fast tests. `npm run test:e2e` starts a real Obsidian, with Overleaf played by a local Git repository. `node build.js --install <vault>` builds and installs. `npm version x.y.z` followed by pushing the tag makes a draft release.

MIT © dieGurken

## Conference templates

Tectonic is XeTeX. Templates whose style loads `times` (ICML, NeurIPS) need `\usepackage[T1]{fontenc}` before the style, else the PDF is set in Latin Modern instead of Times. Check with `pdffonts`: Nimbus Roman (Times), Type 1, embedded. Style files not in the bundle go beside the `.tex`.
