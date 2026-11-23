(() => {
  if (window.__fileHtmlEditor) return;

  const path = decodeURIComponent(location.pathname);
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const type = document.contentType;
  const kind = type === 'text/html' ? 'html' : type.startsWith('text/') || type === 'application/json' ? 'text' : null;
  if (!kind || !fileName) return;

  const RESUME_KEY = `file-html-editor:resume:${path}`;
  const UTF8_BOM = '﻿';

  let mode = 'off';
  // Held in memory only: every file:// page shares one storage origin, so a persisted handle would be readable by any local file.
  let handle;
  let dirty = false;
  let busy = false;
  let reloadOnLeave = false;
  let scriptWarned = false;
  let sourceFormat = { bom: false, eol: '\n' };
  let sourceModified = 0;
  let host, statusEl, textarea, buttons;

  const CSS = `
    :host { all: initial; }
    .bar { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; display: flex; gap: 4px; align-items: center;
      padding: 4px; background: #1f2328; color: #e6edf3; font: 12px/1.2 system-ui, sans-serif; border-radius: 6px;
      box-shadow: 0 2px 8px rgb(0 0 0 / .35); user-select: none; }
    button { font: inherit; color: inherit; background: #30363d; border: 0; border-radius: 4px; padding: 4px 8px; cursor: pointer; }
    button:hover { background: #484f58; }
    button.on { background: #1f6feb; }
    .status { padding: 0 6px; max-width: 48ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    textarea { position: fixed; inset: 0; z-index: 2147483646; box-sizing: border-box; width: 100%; height: 100%; margin: 0;
      padding: 12px 12px 56px; border: 0; outline: 0; resize: none; background: #0d1117; color: #e6edf3;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; tab-size: 2; white-space: pre; }
    textarea[hidden] { display: none; }
  `;

  class NotUtf8Error extends Error {}

  const setStatus = text => { if (statusEl) statusEl.textContent = text; };
  const linkedLabel = () => (handle ? `linked: ${handle.name}` : 'not linked, Save asks for the file');

  function markDirty() {
    if (dirty) return;
    dirty = true;
    setStatus(`● unsaved · ${linkedLabel()}`);
  }

  function buildUi() {
    host = document.createElement('file-html-editor');
    host.setAttribute('data-file-html-editor', '');
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = `<textarea spellcheck="false" hidden></textarea>
      <div class="bar" contenteditable="false">
        <button data-act="visual" title="Edit the rendered page">Visual</button>
        <button data-act="source" title="Edit the file on disk">Source</button>
        <button data-act="save" title="Save (Cmd/Ctrl+S)">Save</button>
        <span class="status"></span>
        <button data-act="close" title="Close (Alt+Shift+E)">×</button>
      </div>`;
    textarea = root.querySelector('textarea');
    statusEl = root.querySelector('.status');
    if (kind === 'text') root.querySelector('[data-act=visual]').remove();
    buttons = root.querySelectorAll('button[data-act]');
    const actions = { visual: enterVisual, source: enterSource, save, close };
    root.querySelector('.bar').addEventListener('click', e => {
      if (!e.isTrusted) return;
      const act = e.target.closest('button')?.dataset.act;
      if (act) actions[act]();
    });
    textarea.addEventListener('input', markDirty);
    textarea.addEventListener('keydown', e => {
      if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      // execCommand keeps the native undo stack; setRangeText does not.
      if (!document.execCommand('insertText', false, '\t')) {
        textarea.setRangeText('\t', textarea.selectionStart, textarea.selectionEnd, 'end');
        markDirty();
      }
    });
  }

  function render() {
    buttons.forEach(b => b.classList.toggle('on', b.dataset.act === mode));
    textarea.hidden = mode !== 'source';
    document.designMode = mode === 'visual' ? 'on' : 'off';
    if (mode === 'source') textarea.focus();
  }

  function fail(error) {
    if (error instanceof NotUtf8Error) return setStatus('file is not valid UTF-8, refusing to edit');
    if (error?.name === 'AbortError') return setStatus(`cancelled · ${linkedLabel()}`);
    if (error?.name === 'NotFoundError') { handle = undefined; return setStatus('linked file is gone, Save to relink'); }
    if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') return setStatus('click Source or Save to grant file access');
    setStatus(`error: ${error?.message ?? error}`);
  }

  async function ensureHandle() {
    if (handle && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted'
        && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') handle = undefined;
    if (handle) return handle;
    if (!window.showOpenFilePicker) throw new Error('File System Access API unavailable');
    setStatus(`pick ${fileName} to link it`);
    const [picked] = await window.showOpenFilePicker({ id: 'file-html-editor' });
    if ((await picked.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('write permission denied');
    if (picked.name !== fileName && !confirm(`You picked "${picked.name}" but this page is "${fileName}". Link it anyway?`)) {
      throw new DOMException('not linked', 'AbortError');
    }
    handle = picked;
    return handle;
  }

  async function readSource() {
    const file = await handle.getFile();
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
    } catch {
      throw new NotUtf8Error();
    }
    const bom = text.startsWith(UTF8_BOM);
    const body = bom ? text.slice(1) : text;
    sourceFormat = { bom, eol: body.includes('\r\n') ? '\r\n' : '\n' };
    sourceModified = file.lastModified;
    return body;
  }

  // A textarea normalises CRLF to LF, so the file's original line endings and BOM are restored on write.
  const encodeSource = value => (sourceFormat.bom ? UTF8_BOM : '') + (sourceFormat.eol === '\n' ? value : value.replace(/\n/g, sourceFormat.eol));

  function serializeDom() {
    const root = document.documentElement.cloneNode(true);
    root.querySelectorAll('[data-file-html-editor]').forEach(n => n.remove());
    const dt = document.doctype;
    if (!dt) return `${root.outerHTML}\n`;
    const ids = dt.publicId ? ` PUBLIC "${dt.publicId}"${dt.systemId ? ` "${dt.systemId}"` : ''}` : dt.systemId ? ` SYSTEM "${dt.systemId}"` : '';
    return `<!DOCTYPE ${dt.name}${ids}>\n${root.outerHTML}\n`;
  }

  function leave(next) {
    if (dirty && !confirm('Discard unsaved edits?')) return false;
    const mustReload = reloadOnLeave || (dirty && mode === 'visual');
    dirty = false;
    if (!mustReload) return true;
    if (next !== 'off') { try { sessionStorage.setItem(RESUME_KEY, next); } catch {} }
    location.reload();
    return false;
  }

  function enterVisual() {
    if (mode === 'visual') return;
    if (mode === 'source' && !leave('visual')) return;
    mode = 'visual';
    render();
    setStatus(linkedLabel());
  }

  async function enterSource() {
    if (mode === 'source' || busy) return;
    busy = true;
    try {
      await ensureHandle();
      if (mode === 'visual' && dirty) {
        if (!confirm('Source edits the file on disk. Discard your unsaved visual edits?')) return;
        dirty = false;
        reloadOnLeave = true;
      }
      textarea.value = await readSource();
    } catch (error) {
      return fail(error);
    } finally {
      busy = false;
    }
    mode = 'source';
    render();
    textarea.setSelectionRange(0, 0);
    textarea.scrollTop = 0;
    setStatus(linkedLabel());
  }

  async function save() {
    if (mode === 'off' || busy) return;
    busy = true;
    try {
      await ensureHandle();
      let content;
      if (mode === 'source') {
        const onDisk = await handle.getFile();
        if (onDisk.lastModified !== sourceModified && !confirm(`${handle.name} changed on disk after you opened it. Overwrite it?`)) return;
        content = encodeSource(textarea.value);
      } else {
        if (document.characterSet !== 'UTF-8') return setStatus(`page is ${document.characterSet}, use Source`);
        if (!scriptWarned && document.querySelector('script')) {
          if (!confirm('This page runs scripts. Visual save writes the live DOM, including anything the scripts generated, so they may run twice on next load. Use Source to edit the original. Save anyway?')) return;
          scriptWarned = true;
        }
        content = serializeDom();
      }
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      if (mode === 'source') {
        sourceModified = (await handle.getFile()).lastModified;
        reloadOnLeave = true;
      }
    } catch (error) {
      return fail(error);
    } finally {
      busy = false;
    }
    dirty = false;
    setStatus(`saved ${handle.name} ${new Date().toLocaleTimeString()}`);
  }

  function open(target) {
    if (!host) buildUi();
    if (!host.isConnected) document.documentElement.append(host);
    if (target === 'visual' && kind === 'html') enterVisual();
    else enterSource();
  }

  function close() {
    if (mode === 'off' || !leave('off')) return;
    mode = 'off';
    render();
    host.remove();
  }

  const toggle = () => (mode === 'off' ? open(kind === 'html' ? 'visual' : 'source') : close());

  document.addEventListener('input', e => { if (mode === 'visual' && e.target !== host) markDirty(); }, true);
  document.addEventListener('keydown', e => {
    if (!e.isTrusted) return;
    if (e.altKey && e.shiftKey && e.code === 'KeyE') { e.preventDefault(); toggle(); return; }
    if (mode !== 'off' && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  }, true);
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  window.__fileHtmlEditor = { toggle };

  let resume = null;
  try { resume = sessionStorage.getItem(RESUME_KEY); sessionStorage.removeItem(RESUME_KEY); } catch {}
  if (resume === 'visual') open('visual');
})();
