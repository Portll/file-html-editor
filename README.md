# File HTML Editor

A Chrome extension that edits any page opened from a `file://` URL and saves the result back to the same file.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open the extension's **Details** and turn on **Allow access to file URLs**.

## Use

Open a local file in Chrome, then press **Alt+Shift+E** or click the extension's toolbar icon.

- **Visual** (HTML only): edit the rendered page in place. Cmd/Ctrl+B, I, U and undo work as usual.
- **Source**: edit the file's text exactly as it is on disk. Plain-text files (`.txt`, `.md`, `.json`, `.js`, …) open in this mode.
- **Save** or **Cmd/Ctrl+S**: writes to the file.

The first save or Source open after a page load asks you to pick the file, because Chrome does not let a page write to its own path. The picker opens in the folder you last used. The link lasts until the page reloads.

## Security

- The editor runs in the extension's isolated world, so the page's own scripts cannot call it, read the file link or replace the functions it uses.
- File links are held in memory and never stored. All `file://` pages share one storage origin, so a stored link would be readable by any local HTML file you open.
- Only real key presses and clicks trigger a save. Events a page script dispatches are ignored, and the toolbar sits in a closed shadow root.
- Linking a file whose name differs from the page asks for confirmation. Source save asks before overwriting a file that changed on disk after you opened it.

## Limits

- Visual save writes the live DOM. On a page whose scripts generate content, that content gets written into the file and the scripts render it again on next load. The editor warns you before the first visual save on any page with scripts. Use Source for those pages.
- Source mode keeps the file's BOM and CRLF line endings. It refuses to open a file that is not valid UTF-8.
- Visual save refuses pages whose character set is not UTF-8.
- Images, PDFs, SVG and XML viewers are not handled.
