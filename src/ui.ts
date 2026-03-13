/**
 * Generates the HTML for the lengcat-vst session-management dashboard.
 *
 * The dashboard is served at GET /_ui and provides:
 *   - A sidebar listing all registered sessions with live status.
 *   - A main content area that embeds the selected session in an <iframe>.
 *   - A "New Session" dialog for creating and launching a new backend.
 *   - Buttons for launching/stopping individual sessions.
 *   - A "Launch" confirmation dialog that lets the user override the folder.
 *
 * All interaction with the proxy is done via the REST API at /api/*.
 */

export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>lengcat-vst — Session Manager</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      display: flex; height: 100vh; overflow: hidden;
      background: #1e1e2e; color: #cdd6f4;
    }

    /* ── Sidebar ────────────────────────────────────────────────── */
    #sidebar {
      width: 270px; min-width: 270px;
      background: #181825;
      border-right: 1px solid #313244;
      display: flex; flex-direction: column;
      overflow: hidden;
      transition: width 0.18s ease, min-width 0.18s ease;
      position: relative;
    }
    #sidebar.collapsed {
      width: 48px; min-width: 48px;
    }
    #sidebar-header {
      padding: 14px 10px 10px;
      border-bottom: 1px solid #313244;
      display: flex; align-items: center; justify-content: space-between;
      gap: 6px; flex-shrink: 0;
    }
    #sidebar-header h1 {
      font-size: 13px; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; color: #89b4fa;
      overflow: hidden; transition: opacity 0.15s;
    }
    #sidebar.collapsed #sidebar-header h1 { opacity: 0; pointer-events: none; width: 0; }
    #sidebar.collapsed #btn-new-session { display: none; }

    #btn-new-session {
      background: #89b4fa; color: #1e1e2e;
      border: none; border-radius: 4px;
      width: 24px; height: 24px;
      font-size: 18px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      line-height: 1; flex-shrink: 0;
    }
    #btn-new-session:hover { background: #b4d0fb; }

    #btn-toggle-sidebar {
      background: none; border: none; cursor: pointer;
      color: #6c7086; padding: 2px 4px; border-radius: 4px;
      font-size: 14px; line-height: 1; flex-shrink: 0;
      transition: color 0.1s;
    }
    #btn-toggle-sidebar:hover { color: #cdd6f4; background: #313244; }

    #session-list { flex: 1; overflow-y: auto; padding: 8px; }
    #sidebar.collapsed #session-list { padding: 8px 4px; }
    #sidebar.collapsed #no-sessions { display: none !important; }

    .session-item {
      padding: 9px 10px; border-radius: 6px;
      margin-bottom: 4px; cursor: pointer;
      border: 1px solid transparent;
      display: flex; flex-direction: column; gap: 3px;
      transition: background 0.1s;
    }
    .session-item:hover { background: #313244; }
    .session-item.active { border-color: #89b4fa; background: #313244; }
    .session-item-name {
      font-size: 13px; font-weight: 500;
      display: flex; align-items: center; gap: 6px; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .session-item-meta { font-size: 11px; color: #6c7086; }
    .session-item-folder { font-size: 11px; color: #a6e3a1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Collapsed: only show the status dot, centred */
    #sidebar.collapsed .session-item {
      padding: 8px 0; align-items: center; border-color: transparent;
    }
    #sidebar.collapsed .session-item-name > *:not(.dot) { display: none; }
    #sidebar.collapsed .session-item-meta,
    #sidebar.collapsed .session-item-folder,
    #sidebar.collapsed .badge-exthost { display: none; }

    .dot {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; flex-shrink: 0;
    }
    .dot-running  { background: #a6e3a1; }
    .dot-stopped  { background: #6c7086; }
    .dot-starting { background: #f9e2af; animation: pulse 1s infinite; }
    .dot-error    { background: #f38ba8; }
    @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.4 } }

    .badge-exthost {
      font-size: 9px; font-weight: 600; letter-spacing: 0.04em;
      background: #313244; color: #89b4fa;
      border: 1px solid #45475a; border-radius: 3px;
      padding: 1px 4px; flex-shrink: 0;
    }

    /* ── Main area ──────────────────────────────────────────────── */
    #main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

    #toolbar {
      padding: 7px 10px;
      background: #181825; border-bottom: 1px solid #313244;
      display: flex; align-items: center; gap: 8px; flex-shrink: 0;
    }
    #toolbar-title { font-size: 13px; flex: 1; color: #a6adc8; }

    .btn {
      padding: 5px 13px; border-radius: 4px; border: none;
      cursor: pointer; font-size: 12px; font-weight: 500;
    }
    .btn-primary  { background: #89b4fa; color: #1e1e2e; }
    .btn-primary:hover  { background: #b4d0fb; }
    .btn-danger   { background: #f38ba8; color: #1e1e2e; }
    .btn-danger:hover   { background: #f7a8ba; }
    .btn-secondary { background: #313244; color: #cdd6f4; }
    .btn-secondary:hover { background: #45475a; }

    #content-area { flex: 1; position: relative; overflow: hidden; }

    iframe {
      position: absolute; inset: 0;
      width: 100%; height: 100%; border: none;
      background: #fff;
    }

    #welcome {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 14px; color: #6c7086;
    }
    #welcome h2 { font-size: 20px; color: #cdd6f4; font-weight: 500; }
    #welcome p  { font-size: 13px; text-align: center; max-width: 320px; line-height: 1.6; }

    /* ── Modal ──────────────────────────────────────────────────── */
    .modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 200;
    }
    .modal-backdrop.hidden { display: none; }
    .modal {
      background: #181825; border: 1px solid #313244;
      border-radius: 10px; padding: 24px; width: 400px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.6);
    }
    .modal h2 { font-size: 15px; font-weight: 600; margin-bottom: 18px; }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 11px; color: #89b4fa; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.06em; }
    select, input[type=text], input[type=number] {
      width: 100%; padding: 8px 10px;
      background: #313244; border: 1px solid #45475a;
      border-radius: 5px; color: #cdd6f4; font-size: 13px;
    }
    select:focus, input:focus { outline: none; border-color: #89b4fa; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
    .form-hint { font-size: 11px; color: #6c7086; margin-top: 3px; }

    #error-banner {
      padding: 9px 14px; background: #f38ba8; color: #1e1e2e;
      font-size: 12px; font-weight: 500; display: none;
    }
  </style>
</head>
<body>

<!-- ── Sidebar ──────────────────────────────────────────── -->
<div id="sidebar">
  <div id="sidebar-header">
    <button id="btn-toggle-sidebar" title="Collapse sidebar">◀</button>
    <h1>Sessions</h1>
    <button id="btn-new-session" title="New session">+</button>
  </div>
  <div id="session-list">
    <div id="no-sessions" style="padding:12px 8px;font-size:12px;color:#6c7086;">
      No sessions yet. Click + to add one.
    </div>
  </div>
</div>

<!-- ── Main ─────────────────────────────────────────────── -->
<div id="main">
  <div id="error-banner"></div>
  <div id="toolbar">
    <span id="toolbar-title">No session selected</span>
    <button class="btn btn-primary"  id="btn-launch" style="display:none">Launch</button>
    <button class="btn btn-danger"   id="btn-stop"   style="display:none">Stop</button>
    <button class="btn btn-secondary" id="btn-open-new-tab" style="display:none" title="Open in new tab">↗ New tab</button>
    <button class="btn btn-danger"   id="btn-remove" style="display:none">Remove</button>
  </div>
  <div id="content-area">
    <div id="welcome">
      <h2>lengcat-vst</h2>
      <p>Select a session from the sidebar to view it here, or create a new one with the <strong>+</strong> button.</p>
    </div>
    <iframe id="session-frame" style="display:none" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"></iframe>
  </div>
</div>

<!-- ── New-session modal ─────────────────────────────────── -->
<div class="modal-backdrop hidden" id="modal-backdrop">
  <div class="modal">
    <h2>New Session</h2>
    <div class="form-group">
      <label>Backend type</label>
      <select id="new-type">
        <option value="vscodium">VSCodium (codium / ~/.vscodium-server)</option>
        <option value="vscode">VS Code (code / ~/.vscode-server)</option>
        <option value="lingma">Lingma</option>
        <option value="qoder">Qoder</option>
        <option value="custom">Custom executable</option>
      </select>
    </div>
    <div class="form-group" id="custom-exe-group" style="display:none">
      <label>Executable path</label>
      <input type="text" id="new-executable" placeholder="/opt/myide/bin/myide" />
    </div>
    <div class="form-group">
      <label>Backend host</label>
      <input type="text" id="new-host" value="127.0.0.1" />
    </div>
    <div class="form-group">
      <label>Backend port</label>
      <input type="number" id="new-port" value="8000" min="1" max="65535" />
    </div>
    <div class="form-group">
      <label>Connection token (leave empty for none)</label>
      <input type="text" id="new-token" placeholder="optional" />
    </div>
    <div class="form-group">
      <label>Workspace / folder (optional)</label>
      <input type="text" id="new-folder" placeholder="/home/user/my-project" />
      <div class="form-hint">Opened automatically when the session loads in the browser.</div>
    </div>
    <div class="form-group">
      <label>
        <input type="checkbox" id="new-ext-host" style="width:auto;margin-right:6px;" />
        Extension-host only (Remote-SSH / ~/.vscode-server binary — no serve-web)
      </label>
      <div class="form-hint">Enable when the remote server was started by VS Code Remote-SSH or is a standalone code-server binary that does not accept the <em>serve-web</em> subcommand.</div>
    </div>
    <div class="form-group">
      <label>
        <input type="checkbox" id="new-launch" checked style="width:auto;margin-right:6px;" />
        Launch backend process automatically
      </label>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="btn-cancel-modal">Cancel</button>
      <button class="btn btn-primary"   id="btn-confirm-modal">Create</button>
    </div>
  </div>
</div>

<!-- ── Launch-with-folder modal ──────────────────────────── -->
<div class="modal-backdrop hidden" id="launch-modal-backdrop">
  <div class="modal">
    <h2>Launch Session</h2>
    <div class="form-group">
      <label>Workspace / folder (optional)</label>
      <input type="text" id="launch-folder" placeholder="/home/user/my-project" />
      <div class="form-hint">Leave empty to use the folder configured when the session was created, or enter a path to override it for this launch.</div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="btn-cancel-launch-modal">Cancel</button>
      <button class="btn btn-primary"   id="btn-confirm-launch-modal">Launch</button>
    </div>
  </div>
</div>

<script>
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  let sessions = [];
  let activeId = null;
  let pollTimer = null;

  // ── DOM refs ─────────────────────────────────────────────────
  const sessionList       = document.getElementById('session-list');
  const noSessions        = document.getElementById('no-sessions');
  const toolbarTitle      = document.getElementById('toolbar-title');
  const btnLaunch         = document.getElementById('btn-launch');
  const btnStop           = document.getElementById('btn-stop');
  const btnOpenNewTab     = document.getElementById('btn-open-new-tab');
  const btnRemove         = document.getElementById('btn-remove');
  const frame             = document.getElementById('session-frame');
  const welcome           = document.getElementById('welcome');
  const errorBanner       = document.getElementById('error-banner');

  // New-session modal
  const modalBackdrop     = document.getElementById('modal-backdrop');
  const newType           = document.getElementById('new-type');
  const newExeGroup       = document.getElementById('custom-exe-group');
  const newExe            = document.getElementById('new-executable');
  const newHost           = document.getElementById('new-host');
  const newPort           = document.getElementById('new-port');
  const newToken          = document.getElementById('new-token');
  const newFolder         = document.getElementById('new-folder');
  const newExtHost        = document.getElementById('new-ext-host');
  const newLaunch         = document.getElementById('new-launch');

  // Launch-with-folder modal
  const launchModalBackdrop = document.getElementById('launch-modal-backdrop');
  const launchFolder        = document.getElementById('launch-folder');

  // ── Helpers ──────────────────────────────────────────────────
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
    setTimeout(() => { errorBanner.style.display = 'none'; }, 5000);
  }

  async function apiFetch(url, opts) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) {
        const body = await r.text();
        throw new Error(body || r.statusText);
      }
      if (r.status === 204) return null;
      return await r.json();
    } catch (e) {
      showError(e.message);
      throw e;
    }
  }

  function statusDotClass(status) {
    return 'dot dot-' + (status || 'stopped');
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderSessionList() {
    const items = sessionList.querySelectorAll('.session-item');
    items.forEach(el => el.remove());

    noSessions.style.display = sessions.length === 0 ? 'block' : 'none';

    sessions.forEach(s => {
      const el = document.createElement('div');
      el.className = 'session-item' + (s.id === activeId ? ' active' : '');
      el.dataset.id = s.id;

      const extBadge = s.extensionHostOnly
        ? '<span class="badge-exthost">ext-host</span>'
        : '';
      const folderLine = s.folder
        ? '<div class="session-item-folder" title="' + escHtml(s.folder) + '">📁 ' + escHtml(s.folder) + '</div>'
        : '';

      el.innerHTML =
        '<div class="session-item-name">' +
          '<span class="' + statusDotClass(s.status) + '"></span>' +
          escHtml(s.type + ' :' + s.port) +
          extBadge +
        '</div>' +
        '<div class="session-item-meta">' + escHtml(s.pathPrefix) + '</div>' +
        folderLine;
      el.addEventListener('click', () => selectSession(s.id));
      sessionList.appendChild(el);
    });
  }

  function updateToolbar() {
    const s = sessions.find(x => x.id === activeId);
    if (!s) {
      toolbarTitle.textContent = 'No session selected';
      btnLaunch.style.display = 'none';
      btnStop.style.display = 'none';
      btnOpenNewTab.style.display = 'none';
      btnRemove.style.display = 'none';
      return;
    }
    const extLabel = s.extensionHostOnly ? ' [ext-host]' : '';
    toolbarTitle.textContent = s.type + extLabel + ' — port ' + s.port + ' — ' + s.pathPrefix;
    btnLaunch.style.display     = s.status === 'stopped' || s.status === 'error' ? 'inline-block' : 'none';
    btnStop.style.display       = s.status === 'running' || s.status === 'starting' ? 'inline-block' : 'none';
    btnOpenNewTab.style.display = s.status === 'running' ? 'inline-block' : 'none';
    btnRemove.style.display     = 'inline-block';
  }

  function selectSession(id) {
    activeId = id;
    renderSessionList();
    updateToolbar();
    loadFrame();
  }

  function sessionIframeUrl(s) {
    let url = s.pathPrefix + '/';
    if (s.folder) {
      url += '?folder=' + encodeURIComponent(s.folder);
    }
    return url;
  }

  function loadFrame() {
    const s = sessions.find(x => x.id === activeId);
    if (!s || s.status !== 'running') {
      frame.style.display = 'none';
      welcome.style.display = 'flex';
      welcome.querySelector('p').textContent =
        s ? 'Session is ' + s.status + '. Use Launch to start it.' :
            'Select a session or create a new one.';
      return;
    }
    welcome.style.display = 'none';
    frame.style.display = 'block';
    const url = sessionIframeUrl(s);
    if (frame.src !== location.origin + url) {
      frame.src = url;
    }
  }

  // ── API calls ────────────────────────────────────────────────
  async function fetchSessions() {
    try {
      sessions = await apiFetch('/api/sessions');
      renderSessionList();
      updateToolbar();
      loadFrame();
    } catch (_) { /* error already shown */ }
  }

  async function launchSession(id, folder) {
    const body = {};
    if (folder) body.folder = folder;
    await apiFetch('/api/sessions/' + id + '/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await fetchSessions();
    selectSession(id);
  }

  async function stopSession(id) {
    await apiFetch('/api/sessions/' + id + '/stop', { method: 'POST' });
    frame.style.display = 'none';
    welcome.style.display = 'flex';
    await fetchSessions();
  }

  async function removeSession(id) {
    if (!confirm('Remove this session?')) return;
    await apiFetch('/api/sessions/' + id, { method: 'DELETE' });
    if (activeId === id) {
      activeId = null;
      frame.style.display = 'none';
      welcome.style.display = 'flex';
    }
    await fetchSessions();
  }

  async function createSession() {
    const type       = newType.value;
    const host       = newHost.value.trim() || '127.0.0.1';
    const port       = parseInt(newPort.value, 10);
    const token      = newToken.value.trim();
    const folder     = newFolder.value.trim();
    const launch     = newLaunch.checked;
    const executable = newExe.value.trim();
    const extensionHostOnly = newExtHost.checked;

    if (!port || port < 1 || port > 65535) {
      showError('Invalid port number.');
      return;
    }

    const body = { type, host, port, launch, extensionHostOnly,
      tokenSource: token ? 'fixed' : 'none',
      token: token || undefined,
      folder: folder || undefined,
      executable: executable || undefined,
    };

    const session = await apiFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    closeNewModal();
    await fetchSessions();
    selectSession(session.id);
  }

  // ── New-session modal ────────────────────────────────────────
  function openNewModal() {
    modalBackdrop.classList.remove('hidden');
    newType.focus();
  }
  function closeNewModal() {
    modalBackdrop.classList.add('hidden');
  }
  newType.addEventListener('change', () => {
    newExeGroup.style.display = newType.value === 'custom' ? 'block' : 'none';
    const defaults = { vscodium: 8000, vscode: 8000, lingma: 8080, qoder: 8080, custom: 8000 };
    newPort.value = defaults[newType.value] || 8000;
  });

  // ── Launch-with-folder modal ─────────────────────────────────
  function openLaunchModal() {
    const s = sessions.find(x => x.id === activeId);
    launchFolder.value = (s && s.folder) ? s.folder : '';
    launchModalBackdrop.classList.remove('hidden');
    launchFolder.focus();
  }
  function closeLaunchModal() {
    launchModalBackdrop.classList.add('hidden');
  }
  async function confirmLaunch() {
    const folder = launchFolder.value.trim();
    closeLaunchModal();
    if (activeId) await launchSession(activeId, folder);
  }

  // ── Event listeners ──────────────────────────────────────────
  document.getElementById('btn-new-session').addEventListener('click', openNewModal);
  document.getElementById('btn-cancel-modal').addEventListener('click', closeNewModal);
  document.getElementById('btn-confirm-modal').addEventListener('click', createSession);
  modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeNewModal(); });

  document.getElementById('btn-cancel-launch-modal').addEventListener('click', closeLaunchModal);
  document.getElementById('btn-confirm-launch-modal').addEventListener('click', confirmLaunch);
  launchModalBackdrop.addEventListener('click', e => { if (e.target === launchModalBackdrop) closeLaunchModal(); });
  // Enter key in folder field confirms launch
  launchFolder.addEventListener('keydown', e => { if (e.key === 'Enter') confirmLaunch(); });

  // Launch button opens the folder-path dialog instead of launching immediately
  btnLaunch.addEventListener('click', () => { if (activeId) openLaunchModal(); });

  btnStop.addEventListener('click', async () => {
    if (activeId) await stopSession(activeId);
  });
  btnOpenNewTab.addEventListener('click', () => {
    const s = sessions.find(x => x.id === activeId);
    if (s) window.open(sessionIframeUrl(s), '_blank');
  });
  btnRemove.addEventListener('click', async () => {
    if (activeId) await removeSession(activeId);
  });

  // ── Polling ──────────────────────────────────────────────────
  function startPolling() {
    pollTimer = setInterval(fetchSessions, 3000);
  }

  // ── Sidebar collapse ─────────────────────────────────────────
  const sidebar = document.getElementById('sidebar');
  const btnToggle = document.getElementById('btn-toggle-sidebar');
  function setSidebarCollapsed(collapsed) {
    if (collapsed) {
      sidebar.classList.add('collapsed');
      btnToggle.textContent = '▶';
      btnToggle.title = 'Expand sidebar';
    } else {
      sidebar.classList.remove('collapsed');
      btnToggle.textContent = '◀';
      btnToggle.title = 'Collapse sidebar';
    }
    try { localStorage.setItem('sidebar-collapsed', String(collapsed)); } catch (_) {}
  }
  btnToggle.addEventListener('click', () => {
    setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
  });
  // Restore persisted state
  try {
    if (localStorage.getItem('sidebar-collapsed') === 'true') setSidebarCollapsed(true);
  } catch (_) {}

  // ── Init ─────────────────────────────────────────────────────
  fetchSessions().then(startPolling);
})();
</script>
</body>
</html>`;
}
