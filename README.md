# Archipelago

Write a paper in Obsidian twice over: as a **map** of claims and arguments, and as **prose**. Both are one Markdown file. The file becomes LaTeX and a PDF, with Zotero citations and two-way **Overleaf** sync.

## Install

- **Obsidian:** Settings › Community plugins › Browse › *Archipelago* (once it is listed; until then use one of the two ways below). Desktop only.
- **Before it is listed, with BRAT:** install the *BRAT* plugin, run *BRAT: Add a beta plugin for testing*, enter `AISCO-IDEAL/archipelago_obsidian`, then enable *Archipelago*. BRAT also installs later releases.
- **Before it is listed, by hand:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/AISCO-IDEAL/archipelago_obsidian/releases/latest) into `<vault>/.obsidian/plugins/archipelago/` (create the folder), restart Obsidian, and enable *Archipelago* under Settings › Community plugins. Updates are done the same way.
- **Before it is listed, from source:** `git@github.com:AISCO-IDEAL/archipelago_obsidian.git`, then `cd archipelago_obsidian` and `node build.js --install <vault>` (Node 22) builds the plugin and copies it into `<vault>/.obsidian/plugins/archipelago/`. Restart Obsidian and enable *Archipelago*. After a `git pull`, run it again. It does not touch the plugin's `data.json`.
- **PDF:** You need a TeX distribution: TeX Live, MiKTeX or MacTeX.
  - If Obsidian is a Flatpak, install TeX Live for it once:
    `flatpak install flathub org.freedesktop.Sdk.Extension.texlive//26.08`
    The branch must match Obsidian's runtime. Settings › Archipelago shows the exact command.
- **Overleaf sync:** You need an Overleaf plan with Git integration and `git` (the Flatpak includes it). Paste a Git token (Overleaf › Account settings › Git integration) into Settings › Archipelago.

## Features

- **Map:** islands (sections), claim cards, links (`needs`), notes, nested subsections down to LaTeX's depth, and figure, table and equation cards.
- **Prose:** the text of each claim. Numbered headings, styles (bold, italic, strikethrough, highlight, colour, comment) via the context menu or shortcuts, link suggestions.
- **LaTeX / PDF:**
  - Templates live in `<Archipelago folder>/latex_templates/`.
  - Each document has a folder with `figures/`, `.bib`, `.tex` and `.pdf`. The folder is a complete project that Overleaf can compile.
  - The LaTeX view can be edited. *Apply* takes the edits back into the document.
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

- **Network:** only Overleaf sync goes online, to `git.overleaf.com`. The token is sent only there.
- **Token:** stored in Obsidian's secret storage, the system keychain, from Obsidian 1.11.4. Older versions store it in plain text in the plugin settings.
- **Programs it starts:** `pdflatex`, `bibtex` or `biber`, and `git`.
- **Files outside the vault:** LaTeX build files go in `~/.cache/archipelago-latex/`, Overleaf working copies in `~/.cache/archipelago-overleaf/`.
- **Other plugins:** it reads Completr's word list, if Completr is installed, to make suggestions.

## How documents open

A document is a Markdown file, and Obsidian has no API to give a view to some `.md` files and not others. So the plugin wraps `WorkspaceLeaf.prototype.setViewState`: when a file starts with the Archipelago format line, the tab gets this plugin's view instead of the note editor. Only that line decides, nothing else about the leaf is changed, and any failure opens the file as a normal note. "Open as Markdown" is in the view's menu. The wrapper is removed when the plugin is disabled, or switches itself off if another plugin has patched on top of it.

## Planned

AI help for templates and compile errors, collapse and drag of subsections, and Overleaf comments.

## Development

The document model and the LaTeX export and import (`src/core.js`, `latex.js`, `fromlatex.js`, `richtext.js`) are plain UMD modules that do not depend on Obsidian, and `npm test` tests them on their own. They live only in this repository.

`npm test` runs the fast tests. `npm run test:e2e` starts a real Obsidian, with Overleaf played by a local Git repository. `node build.js --install <vault>` builds and installs. `npm version x.y.z` followed by pushing the tag makes a draft release.

MIT © dieGurken

## Installing pdflatex

Debian/Ubuntu: `sudo apt-get install -y texlive-latex-base texlive-fonts-recommended texlive-latex-extra`. Conference templates need the last two: `texlive-fonts-recommended` has the Times metrics (ICML, NeurIPS), `texlive-latex-extra` has `forloop`, `cleveref` and similar packages. Check with `pdflatex --version`.
