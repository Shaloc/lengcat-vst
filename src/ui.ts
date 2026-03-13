/**
 * Generates the HTML for the lengcat-vst session-management dashboard.
 *
 * The dashboard is served at GET /_ui and provides:
 *   - A sidebar listing all registered sessions with live status.
 *   - A main content area that embeds the selected session in an <iframe>.
 *   - A "New Session" dialog for creating and launching a new backend.
 *   - Buttons for launching/stopping individual sessions.
 *
 * All interaction with the proxy is done via the REST API at /_ui/api/*.
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
      width: 270px; min-width: 200px;
      background: #181825;
      border-right: 1px solid #313244;
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    #sidebar-header {
      padding: 14px 16px 10px;
      border-bottom: 1px solid #313244;
      display: flex; align-items: center; justify-content: space-between;
    }
    #sidebar-header h1 {
      font-size: 13px; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; color: #89b4fa;
    }
    #btn-new-session {
      background: #89b4fa; color: #1e1e2e;
      border: none; border-radius: 4px;
      width: 24px; height: 24px;
      font-size: 18px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      line-height: 1; flex-shrink: 0;
    }
    #btn-new-session:hover { background: #b4d0fb; }

    #session-list { flex: 1; overflow-y: auto; padding: 8px; }

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

    .dot {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; flex-shrink: 0;
    }
    .dot-running  { background: #a6e3a1; }
    .dot-stopped  { background: #6c7086; }
    .dot-starting { background: #f9e2af; animation: pulse 1s infinite; }
    .dot-error    { background: #f38ba8; }
    @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.4 } }

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
      border-radius: 10px; padding: 24px; width: 380px;
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
  <div id="error-banner" id="error-banner"></div>
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
        <option value="vscodium">VSCodium (codium)</option>
        <option value="vscode">VS Code (code)</option>
        <option value="lingma">Lingma</option>
        <option value="qoder">Qoder</option>
        <option value="custom">Custom</option>
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

<script>
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  let sessions = [];
  let activeId = null;
  let pollTimer = null;

  // ── DOM refs ─────────────────────────────────────────────────
  const sessionList   = document.getElementById('session-list');
  const noSessions    = document.getElementById('no-sessions');
  const toolbarTitle  = document.getElementById('toolbar-title');
  const btnLaunch     = document.getElementById('btn-launch');
  const btnStop       = document.getElementById('btn-stop');
  const btnOpenNewTab = document.getElementById('btn-open-new-tab');
  const btnRemove     = document.getElementById('btn-remove');
  const frame         = document.getElementById('session-frame');
  const welcome       = document.getElementById('welcome');
  const errorBanner   = document.getElementById('error-banner');
  const modalBackdrop = document.getElementById('modal-backdrop');
  const newType       = document.getElementById('new-type');
  const newExeGroup   = document.getElementById('custom-exe-group');
  const newExe        = document.getElementById('new-executable');
  const newHost       = document.getElementById('new-host');
  const newPort       = document.getElementById('new-port');
  const newToken      = document.getElementById('new-token');
  const newLaunch     = document.getElementById('new-launch');

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
      return await r.json();
    } catch (e) {
      showError(e.message);
      throw e;
    }
  }

  function statusDotClass(status) {
    return 'dot dot-' + (status || 'stopped');
  }

  function renderSessionList() {
    const items = sessionList.querySelectorAll('.session-item');
    items.forEach(el => el.remove());

    noSessions.style.display = sessions.length === 0 ? 'block' : 'none';

    sessions.forEach(s => {
      const el = document.createElement('div');
      el.className = 'session-item' + (s.id === activeId ? ' active' : '');
      el.dataset.id = s.id;
      el.innerHTML =
        '<div class="session-item-name">' +
          '<span class="' + statusDotClass(s.status) + '"></span>' +
          escHtml(s.type + ' :' + s.port) +
        '</div>' +
        '<div class="session-item-meta">' + escHtml(s.pathPrefix) + '</div>';
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
    toolbarTitle.textContent = s.type + ' — port ' + s.port + ' — ' + s.pathPrefix;
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
    const url = s.pathPrefix + '/';
    if (frame.src !== location.origin + url) {
      frame.src = url;
    }
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── API calls ────────────────────────────────────────────────
  async function fetchSessions() {
    try {
      sessions = await apiFetch('/_ui/api/sessions');
      renderSessionList();
      updateToolbar();
      loadFrame();
    } catch (_) { /* error already shown */ }
  }

  async function launchSession(id) {
    await apiFetch('/_ui/api/sessions/' + id + '/launch', { method: 'POST' });
    await fetchSessions();
    selectSession(id);
  }

  async function stopSession(id) {
    await apiFetch('/_ui/api/sessions/' + id + '/stop', { method: 'POST' });
    frame.style.display = 'none';
    welcome.style.display = 'flex';
    await fetchSessions();
  }

  async function removeSession(id) {
    if (!confirm('Remove this session?')) return;
    await apiFetch('/_ui/api/sessions/' + id, { method: 'DELETE' });
    if (activeId === id) {
      activeId = null;
      frame.style.display = 'none';
      welcome.style.display = 'flex';
    }
    await fetchSessions();
  }

  async function createSession() {
    const type  = newType.value;
    const host  = newHost.value.trim() || '127.0.0.1';
    const port  = parseInt(newPort.value, 10);
    const token = newToken.value.trim();
    const launch = newLaunch.checked;
    const executable = newExe.value.trim();

    if (!port || port < 1 || port > 65535) {
      showError('Invalid port number.');
      return;
    }

    const body = { type, host, port, launch,
      tokenSource: token ? 'fixed' : 'none',
      token: token || undefined,
      executable: executable || undefined,
    };

    const session = await apiFetch('/_ui/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    closeModal();
    await fetchSessions();
    selectSession(session.id);
  }

  // ── Modal ────────────────────────────────────────────────────
  function openModal() {
    modalBackdrop.classList.remove('hidden');
    newType.focus();
  }
  function closeModal() {
    modalBackdrop.classList.add('hidden');
  }
  newType.addEventListener('change', () => {
    newExeGroup.style.display = newType.value === 'custom' ? 'block' : 'none';
    // Update default port suggestion
    const defaults = { vscodium: 8000, vscode: 8000, lingma: 8080, qoder: 8080, custom: 8000 };
    newPort.value = defaults[newType.value] || 8000;
  });

  // ── Event listeners ──────────────────────────────────────────
  document.getElementById('btn-new-session').addEventListener('click', openModal);
  document.getElementById('btn-cancel-modal').addEventListener('click', closeModal);
  document.getElementById('btn-confirm-modal').addEventListener('click', createSession);
  modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeModal(); });

  btnLaunch.addEventListener('click', async () => {
    if (activeId) await launchSession(activeId);
  });
  btnStop.addEventListener('click', async () => {
    if (activeId) await stopSession(activeId);
  });
  btnOpenNewTab.addEventListener('click', () => {
    const s = sessions.find(x => x.id === activeId);
    if (s) window.open(s.pathPrefix + '/', '_blank');
  });
  btnRemove.addEventListener('click', async () => {
    if (activeId) await removeSession(activeId);
  });

  // ── Polling ──────────────────────────────────────────────────
  function startPolling() {
    pollTimer = setInterval(fetchSessions, 3000);
  }

  // ── Init ─────────────────────────────────────────────────────
  fetchSessions().then(startPolling);
})();
</script>
</body>
</html>`;
}
