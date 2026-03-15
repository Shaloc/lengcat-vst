/**
 * Generates the HTML for the lengcat-vst session-management dashboard.
 *
 * The dashboard is served at GET /_ui and provides:
 *   - A sidebar listing all registered sessions with live status.
 *   - A main content area that embeds the selected session in an <iframe>.
 *   - A "New Session" dialog for creating and launching a new backend.
 *   - Buttons for launching/stopping individual sessions.
 *   - A "Launch" confirmation dialog that lets the user override the folder.
 *   - Light / dark theme toggle (persisted in localStorage).
 *   - Touch-screen mode toggle (auto-detected, persisted in localStorage).
 *
 * All interaction with the proxy is done via the REST API at /api/*.
 */

/** Minimal HTML-escaping helper used by renderLoginPage(). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders the login page served at GET /_login.
 *
 * @param error  When true, show an "incorrect password" error message.
 * @param next   The URL to redirect to after successful login (must start with /).
 */
export function renderLoginPage(error = false, next = '/'): string {
  const safeNext = escapeHtml(next.startsWith('/') ? next : '/');
  const errorHtml = error
    ? `<div class="login-error" role="alert">Incorrect password — please try again.</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%2389b4fa'/%3E%3Cstop offset='100%25' stop-color='%23cba6f7'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='7' fill='%231e1e2e'/%3E%3Cpath d='M8 10h16v2H8zm0 5h12v2H8zm0 5h14v2H8z' fill='url(%23g)'/%3E%3C/svg%3E" />
  <title>lengcat-vst — Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: #1e1e2e; color: #cdd6f4;
    }
    .login-card {
      background: #181825;
      border: 1px solid #313244;
      border-radius: 12px;
      padding: 36px 32px 28px;
      width: 340px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.55);
    }
    .login-title {
      font-size: 17px; font-weight: 700; text-align: center;
      color: #89b4fa; letter-spacing: 0.06em; margin-bottom: 4px;
    }
    .login-subtitle {
      font-size: 12px; color: #6c7086; text-align: center; margin-bottom: 24px;
    }
    .login-error {
      background: #f38ba8; color: #1e1e2e;
      padding: 8px 12px; border-radius: 5px;
      font-size: 12px; font-weight: 500; margin-bottom: 16px;
    }
    .form-group { margin-bottom: 16px; }
    label {
      display: block; font-size: 11px; color: #89b4fa;
      text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 5px;
    }
    input[type="password"] {
      width: 100%; padding: 9px 12px;
      background: #313244; border: 1px solid #45475a;
      border-radius: 5px; color: #cdd6f4; font-size: 14px;
      outline: none;
    }
    input[type="password"]:focus { border-color: #89b4fa; }
    button[type="submit"] {
      width: 100%; padding: 10px;
      background: #89b4fa; color: #1e1e2e;
      border: none; border-radius: 5px;
      font-size: 13px; font-weight: 600; cursor: pointer;
      margin-top: 6px;
    }
    button[type="submit"]:hover { background: #b4d0fb; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="login-title">lengcat-vst</div>
    <div class="login-subtitle">Session Manager</div>
    ${errorHtml}
    <form method="POST" action="/_login">
      <input type="hidden" name="next" value="${safeNext}" />
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autofocus autocomplete="current-password" />
      </div>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}

export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%2389b4fa'/%3E%3Cstop offset='100%25' stop-color='%23cba6f7'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='7' fill='%231e1e2e'/%3E%3Cpath d='M8 10h16v2H8zm0 5h12v2H8zm0 5h14v2H8z' fill='url(%23g)'/%3E%3C/svg%3E" />
  <title>lengcat-vst — Session Manager</title>
  <style>
    /* ── CSS custom properties (dark theme defaults — Catppuccin Mocha) ── */
    :root {
      --c-base:       #1e1e2e;
      --c-surface:    #181825;
      --c-overlay0:   #313244;
      --c-overlay1:   #45475a;
      --c-text:       #cdd6f4;
      --c-subtext0:   #a6adc8;
      --c-subtext1:   #6c7086;
      --c-accent:     #89b4fa;
      --c-accent-h:   #b4d0fb;
      --c-danger:     #f38ba8;
      --c-danger-h:   #f7a8ba;
      --c-green:      #a6e3a1;
      --c-yellow:     #f9e2af;
      --c-on-accent:  #1e1e2e;
      --c-err-bg:     #2d1b1b;
      --c-err-border: #f38ba8;
    }
    /* ── Light theme overrides (Catppuccin Latte) ─────────────────── */
    body.theme-light {
      --c-base:       #eff1f5;
      --c-surface:    #e6e9ef;
      --c-overlay0:   #ccd0da;
      --c-overlay1:   #bcc0cc;
      --c-text:       #4c4f69;
      --c-subtext0:   #5c5f77;
      --c-subtext1:   #8c8fa1;
      --c-accent:     #1e66f5;
      --c-accent-h:   #04a5e5;
      --c-danger:     #d20f39;
      --c-danger-h:   #e64553;
      --c-green:      #40a02b;
      --c-yellow:     #df8e1d;
      --c-on-accent:  #ffffff;
      --c-err-bg:     #fce5e9;
      --c-err-border: #d20f39;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      display: flex; height: 100vh; overflow: hidden;
      background: var(--c-base); color: var(--c-text);
    }

    /* ── Sidebar ────────────────────────────────────────────────── */
    #sidebar {
      width: 270px; min-width: 270px;
      background: var(--c-surface);
      border-right: 1px solid var(--c-overlay0);
      display: flex; flex-direction: column;
      overflow: hidden;
      transition: width 0.18s ease, min-width 0.18s ease;
      position: relative;
      contain: layout style;
    }
    #sidebar.collapsed {
      width: 48px; min-width: 48px;
    }
    #sidebar-header {
      padding: 14px 10px 10px;
      border-bottom: 1px solid var(--c-overlay0);
      display: flex; align-items: center; justify-content: space-between;
      gap: 6px; flex-shrink: 0;
    }
    #sidebar-header h1 {
      font-size: 13px; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--c-accent);
      overflow: hidden; transition: opacity 0.15s;
    }
    #sidebar.collapsed #sidebar-header h1 { opacity: 0; pointer-events: none; width: 0; overflow: hidden; }
    #sidebar.collapsed #btn-new-session { display: none; }
    #sidebar.collapsed #sidebar-header { justify-content: center; padding: 14px 4px 10px; }

    #btn-new-session {
      background: var(--c-accent); color: var(--c-on-accent);
      border: none; border-radius: 4px;
      width: 24px; height: 24px;
      font-size: 18px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      line-height: 1; flex-shrink: 0;
    }
    #btn-new-session:hover { background: var(--c-accent-h); }

    #btn-toggle-sidebar {
      background: none; border: none; cursor: pointer;
      color: var(--c-subtext1); padding: 2px 4px; border-radius: 4px;
      font-size: 14px; line-height: 1; flex-shrink: 0;
      transition: color 0.1s;
    }
    #btn-toggle-sidebar:hover { color: var(--c-text); background: var(--c-overlay0); }

    #session-list { flex: 1; overflow-y: auto; padding: 8px; }
    #sidebar.collapsed #session-list { padding: 8px 4px; }
    #sidebar.collapsed #no-sessions { display: none !important; }

    #sidebar-footer {
      padding: 8px;
      border-top: 1px solid var(--c-overlay0);
      flex-shrink: 0;
    }
    #btn-cert-settings {
      width: 100%; padding: 7px 10px;
      background: none; border: 1px solid var(--c-overlay1); border-radius: 4px;
      color: var(--c-subtext1); font-size: 12px; cursor: pointer;
      text-align: left; display: flex; align-items: center; gap: 6px;
      transition: background 0.1s, color 0.1s;
    }
    #btn-cert-settings:hover { background: var(--c-overlay0); color: var(--c-text); }
    #sidebar.collapsed #sidebar-footer { padding: 8px 4px; display: flex; justify-content: center; }
    #sidebar.collapsed #btn-cert-settings {
      width: 32px; height: 32px; padding: 0;
      justify-content: center; font-size: 16px;
      border: none;
    }
    #sidebar.collapsed .btn-cert-label { display: none; }

    .session-item {
      padding: 9px 10px; border-radius: 6px;
      margin-bottom: 4px; cursor: pointer;
      border: 1px solid transparent;
      display: flex; flex-direction: column; gap: 3px;
      transition: background 0.15s cubic-bezier(0.25, 1, 0.5, 1), border-color 0.15s cubic-bezier(0.25, 1, 0.5, 1), transform 0.15s cubic-bezier(0.25, 1, 0.5, 1);
    }
    .session-item:hover { background: var(--c-overlay0); transform: translateX(2px); }
    .session-item.active { border-color: var(--c-accent); background: var(--c-overlay0); }
    .session-item-name {
      font-size: 13px; font-weight: 500;
      display: flex; align-items: center; gap: 6px; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .session-item-meta { font-size: 11px; color: var(--c-subtext1); }
    .session-item-folder { font-size: 11px; color: var(--c-green); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-item-error { font-size: 11px; color: var(--c-danger); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Collapsed: only show the status dot, centred */
    #sidebar.collapsed .session-item {
      padding: 8px 0; align-items: center; border-color: transparent;
      overflow: hidden; border-radius: 6px;
    }
    #sidebar.collapsed .session-item.active {
      background: var(--c-overlay0); border-color: transparent;
      box-shadow: inset 3px 0 0 var(--c-accent);
    }
    #sidebar.collapsed .session-item-name {
      justify-content: center;
    }
    #sidebar.collapsed .session-name-text,
    #sidebar.collapsed .session-item-name > *:not(.dot) { display: none; }
    #sidebar.collapsed .session-item-meta,
    #sidebar.collapsed .session-item-folder,
    #sidebar.collapsed .session-item-error,
    #sidebar.collapsed .badge-exthost { display: none; }

    .dot {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; flex-shrink: 0;
    }
    .dot-running  { background: var(--c-green); }
    .dot-stopped  { background: var(--c-subtext1); }
    .dot-starting { background: var(--c-yellow); animation: pulse 1s infinite; }
    .dot-error    { background: var(--c-danger); }
    @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.4 } }

    .badge-exthost {
      font-size: 9px; font-weight: 600; letter-spacing: 0.04em;
      background: var(--c-overlay0); color: var(--c-accent);
      border: 1px solid var(--c-overlay1); border-radius: 3px;
      padding: 1px 4px; flex-shrink: 0;
    }

    /* ── Main area ──────────────────────────────────────────────── */
    #main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

    #toolbar {
      padding: 7px 10px;
      background: var(--c-surface); border-bottom: 1px solid var(--c-overlay0);
      display: flex; align-items: center; gap: 8px; flex-shrink: 0;
    }
    #toolbar-title { font-size: 13px; flex: 1; color: var(--c-subtext0); }

    .btn {
      padding: 5px 13px; border-radius: 4px; border: none;
      cursor: pointer; font-size: 12px; font-weight: 500;
      transition: background 0.15s cubic-bezier(0.25, 1, 0.5, 1), transform 0.1s cubic-bezier(0.25, 1, 0.5, 1);
    }
    .btn:active { transform: scale(0.97); }
    .btn-primary   { background: var(--c-accent);   color: var(--c-on-accent); }
    .btn-primary:hover   { background: var(--c-accent-h); }
    .btn-danger    { background: var(--c-danger);   color: var(--c-on-accent); }
    .btn-danger:hover    { background: var(--c-danger-h); }
    .btn-secondary { background: var(--c-overlay0); color: var(--c-text); }
    .btn-secondary:hover { background: var(--c-overlay1); }

    /* ── Inline SVG icons ───────────────────────────────── */
    .icon {
      display: inline-block; width: 1em; height: 1em;
      vertical-align: -0.125em; fill: currentColor;
      flex-shrink: 0;
    }
    .icon-lg { width: 1.25em; height: 1.25em; }
    .icon-welcome { width: 48px; height: 48px; opacity: 0.3; }

    /* Icon-only toolbar buttons (theme / touch toggles) */
    .btn-icon {
      padding: 5px 8px; font-size: 15px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
    }

    #content-area { flex: 1; position: relative; overflow: hidden; contain: layout style; }

    /* Each session gets its own iframe stacked in #content-area.
       Inactive iframes use visibility:hidden (NOT display:none) so VS Code's
       viewport remains non-zero — preventing the client from thinking it has
       been hidden/minimised and triggering a remote disconnection. */
    #content-area iframe {
      position: absolute; inset: 0;
      width: 100%; height: 100%; border: none;
      background: #fff;
    }

    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    #welcome {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 14px; color: var(--c-subtext1);
      animation: fadeIn 0.3s cubic-bezier(0.25, 1, 0.5, 1);
    }
    #welcome h2 { font-size: 20px; color: var(--c-text); font-weight: 500; }
    #welcome p  { font-size: 13px; text-align: center; max-width: 320px; line-height: 1.6; }

    /* ── Modal ──────────────────────────────────────────────────── */
    .modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 200;
      opacity: 0; transition: opacity 0.2s cubic-bezier(0.25, 1, 0.5, 1);
    }
    .modal-backdrop:not(.hidden) { opacity: 1; }
    .modal-backdrop.hidden { pointer-events: none; }
    .modal {
      background: var(--c-surface); border: 1px solid var(--c-overlay0);
      border-radius: 10px; padding: 24px; width: 400px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.6);
      transform: scale(0.96) translateY(8px); transition: transform 0.2s cubic-bezier(0.25, 1, 0.5, 1);
    }
    .modal-backdrop:not(.hidden) .modal { transform: scale(1) translateY(0); }
    .modal h2 { font-size: 15px; font-weight: 600; margin-bottom: 18px; }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 11px; color: var(--c-accent); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.06em; }
    select, input[type=text], input[type=number] {
      width: 100%; padding: 8px 10px;
      background: var(--c-overlay0); border: 1px solid var(--c-overlay1);
      border-radius: 5px; color: var(--c-text); font-size: 13px;
    }
    select:focus, input:focus { outline: none; border-color: var(--c-accent); }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
    .form-hint { font-size: 11px; color: var(--c-subtext1); margin-top: 3px; }

    @keyframes slideDown { from { transform: translateY(-100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    #error-banner {
      padding: 9px 14px; background: var(--c-danger); color: var(--c-on-accent);
      font-size: 12px; font-weight: 500; display: none;
      animation: slideDown 0.25s cubic-bezier(0.25, 1, 0.5, 1);
    }

    /* Persistent session-level error shown below the toolbar when a session
       has status=error.  Uses a distinct dark-red style to differentiate from
       the transient error-banner above. */
    #session-error-banner {
      padding: 8px 14px;
      background: var(--c-err-bg);
      border-bottom: 1px solid var(--c-err-border);
      color: var(--c-danger);
      font-size: 12px;
      font-family: monospace;
      white-space: pre-wrap;
      word-break: break-all;
      display: none;
    }

    /* ── Touch mode ──────────────────────────────────────────────── */
    /* Applied via body.touch-mode; increases tap targets and font sizes for
       finger-driven interaction on tablets / touch-screen laptops. */
    body.touch-mode .session-item       { padding: 13px 12px; margin-bottom: 6px; }
    body.touch-mode .session-item-name  { font-size: 14px; }
    body.touch-mode .session-item-meta  { font-size: 12px; }
    body.touch-mode #btn-new-session    { width: 32px; height: 32px; font-size: 20px; }
    body.touch-mode #btn-toggle-sidebar { font-size: 18px; padding: 4px 7px; }
    body.touch-mode #btn-cert-settings  { padding: 10px 12px; font-size: 13px; }
    body.touch-mode .btn                { padding: 9px 18px; font-size: 13px; }
    body.touch-mode .btn-icon           { padding: 9px 12px; }
    body.touch-mode #toolbar            { padding: 9px 12px; gap: 10px; }
    body.touch-mode select,
    body.touch-mode input[type=text],
    body.touch-mode input[type=number]  { padding: 11px 12px; font-size: 14px; }
    body.touch-mode label               { font-size: 12px; }
    body.touch-mode .form-hint          { font-size: 12px; }
    body.touch-mode .modal              { padding: 28px 24px; }
    body.touch-mode .dot                { width: 11px; height: 11px; }

    /* ── Focus-visible ───────────────────────────────────────── */
    :focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; border-radius: 4px; }
    button:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }

    /* ── Reduced motion ──────────────────────────────────────── */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }

    /* ── Onboarding overlay ────────────────────────────────── */
    #onboarding-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: var(--c-base);
      display: none; flex-direction: column;
      overflow: hidden;
    }
    #onboarding-overlay.visible { display: flex; }
    .ob-header {
      padding: 16px 24px;
      border-bottom: 1px solid var(--c-overlay0);
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0;
    }
    .ob-header h1 { font-size: 15px; font-weight: 600; color: var(--c-accent); letter-spacing: 0.06em; }
    .ob-content {
      flex: 1; overflow-y: auto; padding: 24px;
      display: flex; flex-direction: column; gap: 16px;
      max-width: 800px; margin: 0 auto; width: 100%;
    }
    .ob-welcome { font-size: 13px; color: var(--c-subtext0); line-height: 1.6; }
    .ob-step {
      background: var(--c-surface);
      border: 1px solid var(--c-overlay0);
      border-radius: 8px; overflow: hidden;
    }
    .ob-step-header {
      padding: 12px 16px;
      display: flex; align-items: center; gap: 10px;
      cursor: pointer; user-select: none;
    }
    .ob-step-header:hover { background: var(--c-overlay0); }
    .ob-step-num {
      width: 24px; height: 24px; border-radius: 50%;
      background: var(--c-overlay0); color: var(--c-subtext0);
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 600; flex-shrink: 0;
    }
    .ob-step.ready .ob-step-num { background: var(--c-green); color: var(--c-base); }
    .ob-step-title { font-size: 14px; font-weight: 500; flex: 1; }
    .ob-step-badge {
      font-size: 11px; font-weight: 500; padding: 2px 8px;
      border-radius: 10px;
    }
    .ob-badge-ready { background: rgba(166,227,161,0.15); color: var(--c-green); }
    .ob-badge-missing { background: rgba(249,226,175,0.15); color: var(--c-yellow); }
    .ob-badge-downloading { background: rgba(137,180,250,0.15); color: var(--c-accent); }
    .ob-step-body {
      padding: 0 16px 16px;
      font-size: 13px; color: var(--c-subtext0); line-height: 1.6;
    }
    .ob-step.ready .ob-step-body { display: none; }
    .ob-code {
      background: var(--c-overlay0); border: 1px solid var(--c-overlay1);
      border-radius: 5px; padding: 10px 12px;
      font-family: monospace; font-size: 12px; color: var(--c-text);
      white-space: pre-wrap; word-break: break-all;
      margin: 8px 0; overflow-x: auto;
    }
    .ob-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
    .ob-progress-bar {
      width: 100%; height: 6px;
      background: var(--c-overlay0); border-radius: 3px;
      overflow: hidden; margin: 8px 0;
    }
    .ob-progress-fill {
      height: 100%; background: var(--c-accent);
      border-radius: 3px; transition: width 0.3s ease;
    }
    .ob-progress-text { font-size: 11px; color: var(--c-subtext1); }
    .ob-upload-zone {
      border: 2px dashed var(--c-overlay1); border-radius: 6px;
      padding: 16px; text-align: center;
      color: var(--c-subtext1); font-size: 12px;
      margin-top: 8px; cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .ob-upload-zone:hover { border-color: var(--c-accent); background: rgba(137,180,250,0.05); }
    .ob-upload-zone.dragover { border-color: var(--c-accent); background: rgba(137,180,250,0.1); }
    .ob-upload-zone input[type=file] { display: none; }
    .ob-hint { font-size: 11px; color: var(--c-subtext1); margin-top: 6px; }
    .ob-section-title { font-size: 12px; font-weight: 600; color: var(--c-accent); margin-top: 12px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
    .ob-terminal-wrap {
      border-top: 1px solid var(--c-overlay0);
      display: flex; flex-direction: column;
      flex-shrink: 0;
      height: 260px; min-height: 100px;
      transition: height 0.2s ease;
    }
    .ob-terminal-wrap.collapsed { height: 36px; min-height: 36px; overflow: hidden; }
    .ob-terminal-header {
      padding: 6px 16px;
      background: var(--c-surface);
      display: flex; align-items: center; justify-content: space-between;
      cursor: pointer; user-select: none; flex-shrink: 0;
      border-bottom: 1px solid var(--c-overlay0);
    }
    .ob-terminal-header span { font-size: 12px; font-weight: 500; color: var(--c-subtext0); }
    #ob-term-container { flex: 1; overflow: hidden; background: #000; }
    .ob-footer {
      padding: 12px 24px;
      border-top: 1px solid var(--c-overlay0);
      display: flex; justify-content: flex-end; gap: 8px;
      flex-shrink: 0;
    }
    .ob-xterm-fallback {
      width: 100%; height: 100%;
      background: #1a1b26; color: #c0caf5;
      border: none; resize: none; outline: none;
      font-family: monospace; font-size: 13px;
      padding: 8px 12px;
    }
  </style>
  <link id="xterm-css" rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" crossorigin="anonymous" />
</head>
<body>

<!-- ── Sidebar ──────────────────────────────────────────── -->
<div id="sidebar">
  <div id="sidebar-header">
    <button id="btn-toggle-sidebar" title="Collapse sidebar" aria-label="Toggle sidebar"><svg class="icon" viewBox="0 0 24 24"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg></button>
    <h1>lengcat-vst</h1>
    <button id="btn-new-session" title="New session" aria-label="Create new session">+</button>
  </div>
  <div id="session-list">
    <div id="no-sessions" style="padding:12px 8px;font-size:12px;color:var(--c-subtext1);">
      No sessions yet — click <strong>＋</strong> above to create your first session.
    </div>
  </div>
  <div id="sidebar-footer">
    <button id="btn-cert-settings" title="Certificate settings" aria-label="Certificate settings"><svg class="icon" viewBox="0 0 24 24"><path d="M19.14 12.94a7.014 7.014 0 0 0 .06-.94c0-.33-.02-.65-.07-.97l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.012 7.012 0 0 0-1.67-.97l-.38-2.65A.488.488 0 0 0 13.72 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.67.97l-2.49-1a.486.486 0 0 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.97s.02.64.07.97l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.38 1.06.72 1.67.97l.38 2.65c.05.24.26.42.49.42h4c.24 0 .44-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.67-.97l2.49 1c.23.09.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM11.72 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg> <span class="btn-cert-label">Certificate</span></button>
  </div>
</div>

<!-- ── Main ─────────────────────────────────────────────── -->
<div id="main">
  <div id="error-banner" role="alert"></div>
  <div id="toolbar">
    <span id="toolbar-title">No session selected</span>
    <button class="btn btn-primary"  id="btn-launch" style="display:none">Launch</button>
    <button class="btn btn-danger"   id="btn-stop"   style="display:none">Stop</button>
    <button class="btn btn-secondary" id="btn-open-new-tab" style="display:none" title="Open in new tab"><svg class="icon" viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7ZM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7Z"/></svg> New tab</button>
    <button class="btn btn-danger"   id="btn-remove" style="display:none">Remove</button>
    <button class="btn btn-secondary btn-icon" id="btn-toggle-theme"  title="Switch to light mode" aria-label="Toggle theme"><svg class="icon icon-lg" viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-3a1 1 0 0 0 1-1V1a1 1 0 1 0-2 0v2a1 1 0 0 0 1 1Zm0 18a1 1 0 0 0-1 1v2a1 1 0 1 0 2 0v-2a1 1 0 0 0-1-1ZM5.64 7.05 4.22 5.64a1 1 0 0 1 1.41-1.41l1.41 1.41a1 1 0 1 1-1.41 1.41Zm12.73 9.9a1 1 0 0 0-1.41 1.41l1.41 1.41a1 1 0 0 0 1.41-1.41l-1.41-1.41ZM4 12a1 1 0 0 0-1-1H1a1 1 0 1 0 0 2h2a1 1 0 0 0 1-1Zm18 0a1 1 0 0 0 1 1h2a1 1 0 1 0 0-2h-2a1 1 0 0 0-1 1ZM5.64 16.95a1 1 0 0 0-1.41 0l-1.41 1.41a1 1 0 0 0 1.41 1.41l1.41-1.41a1 1 0 0 0 0-1.41Zm12.73-9.9a1 1 0 0 0 1.41 0l1.41-1.41a1 1 0 0 0-1.41-1.41l-1.41 1.41a1 1 0 0 0 0 1.41Z"/></svg></button>
    <button class="btn btn-secondary btn-icon" id="btn-toggle-touch"  title="Enable touch mode" aria-label="Toggle touch mode"><svg class="icon icon-lg" viewBox="0 0 24 24"><path d="M9 11.24V7.5a2.5 2.5 0 0 1 5 0v3.74c1.21-.81 2-2.18 2-3.74a4.5 4.5 0 0 0-9 0c0 1.56.79 2.93 2 3.74Zm9.84 4.63-4.54-2.26c-.17-.07-.35-.11-.54-.11H13V7.5a1.5 1.5 0 0 0-3 0v10.74l-3.43-.72a.99.99 0 0 0-.84.24l-.74.74 4.17 4.17c.28.28.66.44 1.06.44h6.16c.71 0 1.32-.54 1.41-1.25l.51-4.5c.07-.65-.21-1.29-.79-1.59l-.67-.33Z"/></svg></button>
  </div>
  <div id="session-error-banner" role="alert"></div>
  <div id="content-area">
    <div id="welcome">
      <svg class="icon-welcome" viewBox="0 0 24 24" fill="currentColor"><path d="M21 2H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7l-2 3v1h8v-1l-2-3h7a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Zm0 12H3V4h18v10Z"/></svg>
      <h2>lengcat-vst</h2>
      <p>Choose a session from the sidebar, or press <strong>＋</strong> to create one.</p>
    </div>
    <!-- Session iframes are created dynamically by JS (one per session id).
         id="session-frame" is kept as a sentinel so tests and tooling can
         locate this area; actual iframes have id="session-frame-{id}". -->
    <span id="session-frame" style="display:none"></span>
  </div>
</div>

<!-- ── New-session modal ─────────────────────────────────── -->
<div class="modal-backdrop hidden" id="modal-backdrop">
  <div class="modal" role="dialog" aria-modal="true">
    <h2>New Session</h2>
    <div class="form-group">
      <label>Backend type</label>
      <select id="new-type">
        <option value="vscode">VS Code (code / ~/.vscode-server)</option>
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
  <div class="modal" role="dialog" aria-modal="true">
    <h2>Launch Session</h2>
    <div class="form-group">
      <label>Workspace / folder (optional)</label>
      <input type="text" id="launch-folder" placeholder="/home/user/my-project" />
      <div class="form-hint">Leave empty to use the default folder, or enter a path to override.</div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="btn-cancel-launch-modal">Cancel</button>
      <button class="btn btn-primary"   id="btn-confirm-launch-modal">Launch</button>
    </div>
  </div>
</div>

<!-- ── Certificate settings modal ───────────────────────── -->
<div class="modal-backdrop hidden" id="cert-modal-backdrop">
  <div class="modal" style="width:460px" role="dialog" aria-modal="true">
    <h2><svg class="icon" viewBox="0 0 24 24"><path d="M19.14 12.94a7.014 7.014 0 0 0 .06-.94c0-.33-.02-.65-.07-.97l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.012 7.012 0 0 0-1.67-.97l-.38-2.65A.488.488 0 0 0 13.72 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.67.97l-2.49-1a.486.486 0 0 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.97s.02.64.07.97l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.38 1.06.72 1.67.97l.38 2.65c.05.24.26.42.49.42h4c.24 0 .44-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.67-.97l2.49 1c.23.09.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM11.72 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg> Certificate Settings</h2>
    <div id="cert-modal-body">
      <!-- Populated by JS when the modal opens -->
    </div>
    <div class="modal-actions" style="margin-top:14px">
      <button class="btn btn-secondary" id="btn-close-cert-modal">Close</button>
    </div>
  </div>
</div>

<!-- ── Onboarding overlay ────────────────────────────────── -->
<div id="onboarding-overlay">
  <div class="ob-header">
    <h1>🔧 lengcat-vst — Setup</h1>
    <button class="btn btn-secondary" id="btn-skip-onboarding">Skip →</button>
  </div>
  <div class="ob-content">
    <p class="ob-welcome">Welcome! Let's make sure your development environment is ready.</p>

    <!-- Step 1: code-server -->
    <div class="ob-step" id="ob-step-cs">
      <div class="ob-step-header" id="ob-cs-header">
        <span class="ob-step-num">1</span>
        <span class="ob-step-title">code-server</span>
        <span class="ob-step-badge ob-badge-missing" id="ob-cs-badge">checking…</span>
      </div>
      <div class="ob-step-body" id="ob-cs-body">
        <p>code-server provides the VS Code editor in your browser.</p>
        <div id="ob-cs-status"></div>
        <div id="ob-cs-progress" style="display:none">
          <div class="ob-progress-bar"><div class="ob-progress-fill" id="ob-cs-progress-fill" style="width:0%"></div></div>
          <div class="ob-progress-text" id="ob-cs-progress-text">Preparing…</div>
        </div>
        <div class="ob-actions" id="ob-cs-actions"></div>
        <div class="ob-upload-zone" id="ob-cs-upload" style="display:none">
          <p>📦 Drop a <code>code-server-*.tar.gz</code> tarball here, or click to browse</p>
          <p class="ob-hint">Download from <a href="https://github.com/coder/code-server/releases" target="_blank" style="color:var(--c-accent)">github.com/coder/code-server/releases</a></p>
          <input type="file" id="ob-cs-file" accept=".tar.gz,.gz" />
        </div>
      </div>
    </div>

    <!-- Step 2: leduo-patrol -->
    <div class="ob-step" id="ob-step-lp">
      <div class="ob-step-header" id="ob-lp-header">
        <span class="ob-step-num">2</span>
        <span class="ob-step-title">leduo-patrol</span>
        <span class="ob-step-badge ob-badge-missing" id="ob-lp-badge">checking…</span>
      </div>
      <div class="ob-step-body" id="ob-lp-body">
        <p>leduo-patrol is the project management dashboard.</p>
        <div id="ob-lp-status"></div>
        <div id="ob-lp-dir-section">
          <div class="ob-section-title">Option A: Clone from Git</div>
          <p>Run in the terminal below:</p>
          <div class="ob-code" id="ob-lp-clone-cmd"></div>
          <div class="ob-section-title">Option B: Upload source tarball</div>
          <div class="ob-upload-zone" id="ob-lp-upload">
            <p>📦 Drop a <code>leduo-patrol.tar.gz</code> source tarball here, or click to browse</p>
            <p class="ob-hint">The tarball will be extracted and npm install will run automatically.</p>
            <input type="file" id="ob-lp-file" accept=".tar.gz,.gz,.tgz" />
          </div>
        </div>
        <div id="ob-lp-env-section" style="display:none">
          <div class="ob-section-title">Create .env file</div>
          <p>Create a <code>.env</code> file in the leduo-patrol directory with the following content:</p>
          <div class="ob-code" id="ob-lp-env-example">PORT=3001
LEDUO_PATROL_WEB_PORT=3002
LEDUO_PATROL_ACCESS_KEY=your-secret-key</div>
          <p class="ob-hint">You can use the terminal below to create this file, or edit it manually.</p>
          <div class="ob-actions" id="ob-lp-env-actions"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Terminal -->
  <div class="ob-terminal-wrap" id="ob-terminal-wrap">
    <div class="ob-terminal-header" id="ob-terminal-header">
      <span>Terminal</span>
      <button class="btn btn-secondary btn-icon" id="btn-toggle-ob-terminal" style="padding:2px 8px;font-size:11px;">▼</button>
    </div>
    <div id="ob-term-container"></div>
  </div>

  <div class="ob-footer">
    <button class="btn btn-secondary" id="btn-refresh-onboarding">↻ Refresh Status</button>
    <button class="btn btn-primary" id="btn-continue-onboarding">Continue to Dashboard →</button>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js" crossorigin="anonymous"></script>
<script>
(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  // ── Onboarding Flow ─────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  var obOverlay = document.getElementById('onboarding-overlay');
  var obTermContainer = document.getElementById('ob-term-container');
  var obTermWrap = document.getElementById('ob-terminal-wrap');
  var obTermHeader = document.getElementById('ob-terminal-header');
  var obTerm = null;   // xterm.js Terminal instance
  var obTermWs = null; // WebSocket to /api/terminal
  var obDownloadPollTimer = null;

  // ── Onboarding: check status on load ──────────────────────────────────
  function obCheckStatus() {
    return fetch('/api/onboarding/status')
      .then(function(r) { return r.json(); })
      .then(function(status) {
        obRenderCodeServer(status.codeServer);
        obRenderLeduoPatrol(status.leduoPatrol);
        if (!status.ready) {
          obOverlay.classList.add('visible');
          obInitTerminal();
        } else {
          obOverlay.classList.remove('visible');
        }
        return status;
      })
      .catch(function() { /* API unavailable — skip onboarding */ });
  }

  // ── code-server step ──────────────────────────────────────────────────
  function obRenderCodeServer(cs) {
    var step = document.getElementById('ob-step-cs');
    var badge = document.getElementById('ob-cs-badge');
    var body = document.getElementById('ob-cs-body');
    var statusEl = document.getElementById('ob-cs-status');
    var actionsEl = document.getElementById('ob-cs-actions');
    var uploadZone = document.getElementById('ob-cs-upload');
    var progressEl = document.getElementById('ob-cs-progress');

    if (cs.installed) {
      step.classList.add('ready');
      badge.textContent = '✓ v' + cs.version;
      badge.className = 'ob-step-badge ob-badge-ready';
      statusEl.innerHTML = '<p style="color:var(--c-green)">✓ code-server v' + cs.version + ' is installed and ready.</p>';
      actionsEl.innerHTML = '';
      uploadZone.style.display = 'none';
      progressEl.style.display = 'none';
      if (obDownloadPollTimer) { clearInterval(obDownloadPollTimer); obDownloadPollTimer = null; }
    } else {
      step.classList.remove('ready');
      badge.textContent = 'not installed';
      badge.className = 'ob-step-badge ob-badge-missing';
      statusEl.innerHTML = '<p>code-server is not installed. Choose an option below:</p>';
      actionsEl.innerHTML =
        '<button class="btn btn-primary" id="ob-cs-download">⬇ Auto Download</button>' +
        '<button class="btn btn-secondary" id="ob-cs-show-upload">📦 Upload Tarball</button>';
      uploadZone.style.display = 'none';
      progressEl.style.display = 'none';

      document.getElementById('ob-cs-download').addEventListener('click', obStartDownload);
      document.getElementById('ob-cs-show-upload').addEventListener('click', function() {
        uploadZone.style.display = uploadZone.style.display === 'none' ? 'block' : 'none';
      });

      // Check if a download is already in progress
      obPollDownloadOnce();
    }
  }

  function obStartDownload() {
    fetch('/api/onboarding/download-code-server', { method: 'POST' })
      .then(function() { obStartDownloadPoll(); })
      .catch(function(e) { alert('Failed to start download: ' + e.message); });
  }

  function obStartDownloadPoll() {
    var progressEl = document.getElementById('ob-cs-progress');
    var actionsEl = document.getElementById('ob-cs-actions');
    var badge = document.getElementById('ob-cs-badge');

    progressEl.style.display = 'block';
    badge.textContent = 'downloading…';
    badge.className = 'ob-step-badge ob-badge-downloading';
    actionsEl.innerHTML =
      '<button class="btn btn-danger" id="ob-cs-cancel">✕ Cancel Download</button>' +
      '<button class="btn btn-secondary" id="ob-cs-show-upload2">📦 Upload Instead</button>';
    document.getElementById('ob-cs-cancel').addEventListener('click', obCancelDownload);
    document.getElementById('ob-cs-show-upload2').addEventListener('click', function() {
      var uz = document.getElementById('ob-cs-upload');
      uz.style.display = uz.style.display === 'none' ? 'block' : 'none';
    });

    if (obDownloadPollTimer) clearInterval(obDownloadPollTimer);
    obDownloadPollTimer = setInterval(obPollDownloadOnce, 1000);
  }

  function obPollDownloadOnce() {
    fetch('/api/onboarding/download-progress')
      .then(function(r) { return r.json(); })
      .then(function(p) {
        if (p.downloading) {
          var fill = document.getElementById('ob-cs-progress-fill');
          var text = document.getElementById('ob-cs-progress-text');
          document.getElementById('ob-cs-progress').style.display = 'block';
          var pct = p.percent >= 0 ? p.percent : 0;
          fill.style.width = pct + '%';
          text.textContent = p.message || ('Downloading… ' + pct + '%');

          var badge = document.getElementById('ob-cs-badge');
          badge.textContent = 'downloading… ' + pct + '%';
          badge.className = 'ob-step-badge ob-badge-downloading';

          // Ensure poll is running
          if (!obDownloadPollTimer) obStartDownloadPoll();
        } else if (p.error) {
          document.getElementById('ob-cs-progress').style.display = 'none';
          if (obDownloadPollTimer) { clearInterval(obDownloadPollTimer); obDownloadPollTimer = null; }
          document.getElementById('ob-cs-status').innerHTML =
            '<p style="color:var(--c-danger)">Download failed: ' + p.error + '</p>';
        } else if (!p.downloading && obDownloadPollTimer) {
          clearInterval(obDownloadPollTimer);
          obDownloadPollTimer = null;
          // Refresh status — may now be installed
          obCheckStatus();
        }
      })
      .catch(function() {});
  }

  function obCancelDownload() {
    fetch('/api/onboarding/cancel-download', { method: 'POST' })
      .then(function() {
        if (obDownloadPollTimer) { clearInterval(obDownloadPollTimer); obDownloadPollTimer = null; }
        document.getElementById('ob-cs-progress').style.display = 'none';
        obCheckStatus();
      })
      .catch(function() {});
  }

  // ── code-server upload ────────────────────────────────────────────────
  (function() {
    var zone = document.getElementById('ob-cs-upload');
    var fileInput = document.getElementById('ob-cs-file');
    zone.addEventListener('click', function(e) { if (e.target !== fileInput) fileInput.click(); });
    zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', function() { zone.classList.remove('dragover'); });
    zone.addEventListener('drop', function(e) {
      e.preventDefault(); zone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) obUploadCodeServer(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', function() {
      if (fileInput.files.length > 0) obUploadCodeServer(fileInput.files[0]);
    });
  })();

  function obUploadCodeServer(file) {
    var statusEl = document.getElementById('ob-cs-status');
    var progressEl = document.getElementById('ob-cs-progress');
    var fill = document.getElementById('ob-cs-progress-fill');
    var text = document.getElementById('ob-cs-progress-text');

    // Cancel any ongoing download first
    fetch('/api/onboarding/cancel-download', { method: 'POST' }).catch(function(){});
    if (obDownloadPollTimer) { clearInterval(obDownloadPollTimer); obDownloadPollTimer = null; }

    statusEl.innerHTML = '<p>Uploading ' + file.name + '…</p>';
    progressEl.style.display = 'block';
    fill.style.width = '0%';
    text.textContent = 'Uploading…';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/onboarding/upload-code-server?filename=' + encodeURIComponent(file.name));
    xhr.upload.addEventListener('progress', function(e) {
      if (e.lengthComputable) {
        var pct = Math.round((e.loaded / e.total) * 100);
        fill.style.width = pct + '%';
        text.textContent = 'Uploading… ' + pct + '%';
      }
    });
    xhr.addEventListener('load', function() {
      if (xhr.status >= 200 && xhr.status < 300) {
        progressEl.style.display = 'none';
        obCheckStatus();
      } else {
        text.textContent = 'Upload failed: ' + xhr.responseText;
        fill.style.width = '100%';
        fill.style.background = 'var(--c-danger)';
      }
    });
    xhr.addEventListener('error', function() {
      text.textContent = 'Upload failed — network error';
    });
    xhr.send(file);
  }

  // ── leduo-patrol step ─────────────────────────────────────────────────
  function obRenderLeduoPatrol(lp) {
    var step = document.getElementById('ob-step-lp');
    var badge = document.getElementById('ob-lp-badge');
    var statusEl = document.getElementById('ob-lp-status');
    var dirSection = document.getElementById('ob-lp-dir-section');
    var envSection = document.getElementById('ob-lp-env-section');
    var cloneCmd = document.getElementById('ob-lp-clone-cmd');
    var envActions = document.getElementById('ob-lp-env-actions');

    if (lp.dirExists && lp.envFileExists) {
      step.classList.add('ready');
      badge.textContent = '✓ Ready';
      badge.className = 'ob-step-badge ob-badge-ready';
      statusEl.innerHTML = '<p style="color:var(--c-green)">✓ leduo-patrol is set up at <code>' + lp.dir + '</code></p>';
      dirSection.style.display = 'none';
      envSection.style.display = 'none';
    } else if (lp.dirExists && !lp.envFileExists) {
      step.classList.remove('ready');
      badge.textContent = '.env missing';
      badge.className = 'ob-step-badge ob-badge-missing';
      statusEl.innerHTML = '<p>Directory found at <code>' + lp.dir + '</code>, but <code>.env</code> file is missing.</p>';
      dirSection.style.display = 'none';
      envSection.style.display = 'block';
      envActions.innerHTML =
        '<button class="btn btn-primary" id="ob-lp-create-env">Create default .env</button>';
      document.getElementById('ob-lp-create-env').addEventListener('click', function() {
        if (obTerm) {
          var cmd = "cat > " + lp.dir + "/.env << 'EOF'\\nPORT=3001\\nLEDUO_PATROL_WEB_PORT=3002\\nLEDUO_PATROL_ACCESS_KEY=changeme\\nEOF\\n";
          obTermWrite(cmd);
        }
      });
    } else {
      step.classList.remove('ready');
      badge.textContent = 'not found';
      badge.className = 'ob-step-badge ob-badge-missing';
      statusEl.innerHTML = '<p>Directory not found: <code>' + lp.dir + '</code></p>';
      dirSection.style.display = 'block';
      envSection.style.display = 'block';
      cloneCmd.textContent =
        'git clone <your-repo-url> ' + lp.dir + '\\n' +
        'cd ' + lp.dir + ' && npm install';
      envActions.innerHTML =
        '<button class="btn btn-primary" id="ob-lp-create-env">Create default .env (after install)</button>';
      document.getElementById('ob-lp-create-env').addEventListener('click', function() {
        if (obTerm) {
          var cmd = "cat > " + lp.dir + "/.env << 'EOF'\\nPORT=3001\\nLEDUO_PATROL_WEB_PORT=3002\\nLEDUO_PATROL_ACCESS_KEY=changeme\\nEOF\\n";
          obTermWrite(cmd);
        }
      });
    }
  }

  // ── leduo-patrol upload ───────────────────────────────────────────────
  (function() {
    var zone = document.getElementById('ob-lp-upload');
    var fileInput = document.getElementById('ob-lp-file');
    zone.addEventListener('click', function(e) { if (e.target !== fileInput) fileInput.click(); });
    zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', function() { zone.classList.remove('dragover'); });
    zone.addEventListener('drop', function(e) {
      e.preventDefault(); zone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) obUploadLeduoPatrol(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', function() {
      if (fileInput.files.length > 0) obUploadLeduoPatrol(fileInput.files[0]);
    });
  })();

  function obUploadLeduoPatrol(file) {
    var statusEl = document.getElementById('ob-lp-status');
    statusEl.innerHTML = '<p>Uploading and extracting ' + file.name + '…</p>';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/onboarding/upload-leduo-patrol');
    xhr.addEventListener('load', function() {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var result = JSON.parse(xhr.responseText);
          statusEl.innerHTML = '<p style="color:var(--c-green)">✓ Extracted to <code>' + result.dir + '</code>' +
            (result.npmInstalled ? ' — npm install completed.' : ' — run <code>npm install</code> in the terminal.') + '</p>';
        } catch(e) {
          statusEl.innerHTML = '<p style="color:var(--c-green)">✓ Uploaded successfully.</p>';
        }
        setTimeout(function() { obCheckStatus(); }, 500);
      } else {
        statusEl.innerHTML = '<p style="color:var(--c-danger)">Upload failed: ' + xhr.responseText + '</p>';
      }
    });
    xhr.addEventListener('error', function() {
      statusEl.innerHTML = '<p style="color:var(--c-danger)">Upload failed — network error</p>';
    });
    xhr.send(file);
  }

  // ── Terminal (xterm.js) ───────────────────────────────────────────────
  function obInitTerminal() {
    if (obTerm) return; // already initialised

    // Try xterm.js first (loaded from CDN), fall back to textarea
    if (typeof Terminal !== 'undefined' && typeof FitAddon !== 'undefined') {
      obTerm = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
        theme: {
          background: '#1a1b26',
          foreground: '#c0caf5',
          cursor: '#c0caf5',
          selectionBackground: 'rgba(137,180,250,0.3)',
        },
      });
      var fitAddon = new FitAddon.FitAddon();
      obTerm.loadAddon(fitAddon);
      obTerm.open(obTermContainer);
      fitAddon.fit();
      window.addEventListener('resize', function() { try { fitAddon.fit(); } catch(e) {} });
      new ResizeObserver(function() { try { fitAddon.fit(); } catch(e) {} }).observe(obTermWrap);
    } else {
      // Fallback: simple textarea
      var ta = document.createElement('textarea');
      ta.className = 'ob-xterm-fallback';
      ta.placeholder = 'Terminal (xterm.js failed to load from CDN)\\nType commands and press Enter…';
      obTermContainer.appendChild(ta);
      obTerm = {
        _ta: ta,
        _buf: '',
        write: function(data) { ta.value += data; ta.scrollTop = ta.scrollHeight; },
        onData: function(cb) {
          ta.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
              cb(ta.value.split('\\n').pop() + '\\n');
            }
          });
        },
        dispose: function() { ta.remove(); },
      };
    }

    // Connect WebSocket
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    obTermWs = new WebSocket(proto + '://' + location.host + '/api/terminal');
    obTermWs.onopen = function() {
      if (obTerm.onData) {
        obTerm.onData(function(data) {
          if (obTermWs && obTermWs.readyState === WebSocket.OPEN) {
            obTermWs.send(data);
          }
        });
      }
    };
    obTermWs.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'exit') {
          obTerm.write('\\r\\n[Process exited with code ' + msg.code + ']\\r\\n');
          return;
        }
      } catch(err) { /* not JSON — raw terminal data */ }
      obTerm.write(e.data);
    };
    obTermWs.onclose = function() {
      obTerm.write('\\r\\n[Connection closed]\\r\\n');
    };
  }

  // Write a command to the terminal (used by action buttons)
  function obTermWrite(cmd) {
    if (obTermWs && obTermWs.readyState === WebSocket.OPEN) {
      obTermWs.send(cmd);
    }
  }

  // ── Terminal toggle ───────────────────────────────────────────────────
  obTermHeader.addEventListener('click', function() {
    obTermWrap.classList.toggle('collapsed');
    document.getElementById('btn-toggle-ob-terminal').textContent =
      obTermWrap.classList.contains('collapsed') ? '▲' : '▼';
  });

  // ── Onboarding buttons ────────────────────────────────────────────────
  document.getElementById('btn-skip-onboarding').addEventListener('click', function() {
    obOverlay.classList.remove('visible');
    try { localStorage.setItem('onboarding-skipped', 'true'); } catch(e) {}
    if (obTermWs) { obTermWs.close(); obTermWs = null; }
    if (obDownloadPollTimer) { clearInterval(obDownloadPollTimer); obDownloadPollTimer = null; }
  });
  document.getElementById('btn-continue-onboarding').addEventListener('click', function() {
    obOverlay.classList.remove('visible');
    try { localStorage.setItem('onboarding-skipped', 'true'); } catch(e) {}
    if (obTermWs) { obTermWs.close(); obTermWs = null; }
    if (obDownloadPollTimer) { clearInterval(obDownloadPollTimer); obDownloadPollTimer = null; }
  });
  document.getElementById('btn-refresh-onboarding').addEventListener('click', function() {
    obCheckStatus();
  });

  // Auto-check onboarding on load (unless previously skipped)
  try {
    if (localStorage.getItem('onboarding-skipped') !== 'true') {
      obCheckStatus();
    }
  } catch(e) {
    obCheckStatus();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Dashboard (existing code below) ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  // ── State ────────────────────────────────────────────────────
  let sessions = [];
  let activeId = null;
  let pollTimer = null;

  // ── DOM refs ─────────────────────────────────────────────────
  const contentArea       = document.getElementById('content-area');
  const sessionList       = document.getElementById('session-list');
  const noSessions        = document.getElementById('no-sessions');
  const toolbarTitle      = document.getElementById('toolbar-title');
  const btnLaunch         = document.getElementById('btn-launch');
  const btnStop           = document.getElementById('btn-stop');
  const btnOpenNewTab     = document.getElementById('btn-open-new-tab');
  const btnRemove         = document.getElementById('btn-remove');
  const welcome           = document.getElementById('welcome');
  const errorBanner       = document.getElementById('error-banner');
  const sessionErrorBanner = document.getElementById('session-error-banner');

  // Per-session iframe pool.  Each running session gets exactly one iframe
  // created on first view; subsequent switches only toggle display — no
  // src reassignment and therefore no reload.
  const iframePool = new Map(); // Map<sessionId: string, HTMLIFrameElement>

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

  function displaySessionType(type) {
    return type === 'leduoPatrol' ? 'leduo-patrol' : type;
  }

  function sortSessionsForDisplay(list) {
    return [...list].sort((a, b) => {
      const aPinned = a.type === 'leduoPatrol' ? 0 : 1;
      const bPinned = b.type === 'leduoPatrol' ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;
      return 0;
    });
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
        ? '<div class="session-item-folder" title="' + escHtml(s.folder) + '"><svg class="icon" viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/></svg> ' + escHtml(s.folder) + '</div>'
        : '';
      const errorLine = (s.status === 'error' && s.errorMessage)
        ? '<div class="session-item-error" title="' + escHtml(s.errorMessage) + '"><svg class="icon" viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z"/></svg> ' + escHtml(s.errorMessage.length > 55 ? s.errorMessage.slice(0, 55) + '…' : s.errorMessage) + '</div>'
        : '';

      // Set tooltip on the session item for collapsed sidebar
      el.title = displaySessionType(s.type) + ' :' + s.port + ' — ' + s.pathPrefix + (s.folder ? '\\n' + s.folder : '');

      el.innerHTML =
        '<div class="session-item-name">' +
          '<span class="' + statusDotClass(s.status) + '"></span>' +
          '<span class="session-name-text">' + escHtml(displaySessionType(s.type) + ' :' + s.port) + '</span>' +
          extBadge +
        '</div>' +
        '<div class="session-item-meta">' + escHtml(s.pathPrefix) + '</div>' +
        folderLine +
        errorLine;
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
      sessionErrorBanner.style.display = 'none';
      return;
    }
    const extLabel = s.extensionHostOnly ? ' [ext-host]' : '';
    toolbarTitle.textContent = displaySessionType(s.type) + extLabel + ' — port ' + s.port + ' — ' + s.pathPrefix;
    btnLaunch.style.display     = s.status === 'stopped' || s.status === 'error' ? 'inline-block' : 'none';
    btnStop.style.display       = s.status === 'running' || s.status === 'starting' ? 'inline-block' : 'none';
    btnOpenNewTab.style.display = s.status === 'running' ? 'inline-block' : 'none';
    btnRemove.style.display     = 'inline-block';

    // Show a persistent error banner when a launch has failed so the user
    // can see exactly why (e.g. "Port 8000 already in use by session s1").
    if (s.status === 'error' && s.errorMessage) {
      sessionErrorBanner.textContent = 'Launch error: ' + s.errorMessage;
      sessionErrorBanner.style.display = 'block';
    } else {
      sessionErrorBanner.style.display = 'none';
    }
  }

  function selectSession(id) {
    activeId = id;
    renderSessionList();
    updateToolbar();
    loadFrame();
  }

  function sessionIframeUrl(s) {
    let url = s.pathPrefix + '/';
    const params = new URLSearchParams();
    if (s.folder) {
      params.set('folder', s.folder);
    }
    if (s.type === 'leduoPatrol' && s.accessKey) {
      params.set('key', s.accessKey);
    }
    const qs = params.toString();
    if (qs) {
      url += '?' + qs;
    }
    return url;
  }

  // Removes iframes whose backend has stopped (crash or natural exit) so that
  // a fresh load occurs the next time the session is relaunched.
  function evictStoppedIframes() {
    for (const [id, iframe] of iframePool) {
      const session = sessions.find(x => x.id === id);
      if (!session || session.status !== 'running') {
        iframe.remove();
        iframePool.delete(id);
      }
    }
  }

  function loadFrame() {
    // Evict iframes whose backend has stopped (e.g. process crashed).
    evictStoppedIframes();

    // Hide all live iframes using visibility:hidden (NOT display:none).
    // display:none collapses the iframe viewport to 0×0 which causes VS Code's
    // web client to think the window has been minimised/hidden and triggers its
    // remote-disconnect lifecycle (join.disconnectRemote), closing the session.
    // visibility:hidden keeps the rendered viewport dimensions intact so VS Code
    // stays connected; pointer-events:none prevents accidental interaction.
    for (const iframe of iframePool.values()) {
      iframe.style.visibility = 'hidden';
      iframe.style.pointerEvents = 'none';
    }

    const s = sessions.find(x => x.id === activeId);
    if (!s || s.status !== 'running') {
      welcome.style.display = 'flex';
      welcome.querySelector('p').textContent =
        s ? 'Session is ' + s.status + '. Press Launch to start it.' :
            'Select a session or create a new one.';
      return;
    }

    // Create the iframe for this session on first view.
    if (!iframePool.has(s.id)) {
      const iframe = document.createElement('iframe');
      iframe.id = 'session-frame-' + s.id;
      iframe.src = sessionIframeUrl(s);
      contentArea.appendChild(iframe);
      iframePool.set(s.id, iframe);
    }

    // Show the active session's iframe.
    welcome.style.display = 'none';
    iframePool.get(s.id).style.visibility = 'visible';
    iframePool.get(s.id).style.pointerEvents = 'auto';
  }

  // ── API calls ────────────────────────────────────────────────
  async function fetchSessions() {
    try {
      sessions = sortSessionsForDisplay(await apiFetch('/api/sessions'));
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
    // Evict the cached iframe so relaunch loads a clean instance.
    if (iframePool.has(id)) {
      iframePool.get(id).remove();
      iframePool.delete(id);
    }
    welcome.style.display = 'flex';
    await fetchSessions();
  }

  async function removeSession(id) {
    if (!confirm('Remove this session? This cannot be undone.')) return;
    await apiFetch('/api/sessions/' + id, { method: 'DELETE' });
    if (iframePool.has(id)) {
      iframePool.get(id).remove();
      iframePool.delete(id);
    }
    if (activeId === id) {
      activeId = null;
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
    const defaults = { vscode: 8000, custom: 8000 };
    newPort.value = String(defaults[newType.value] || 8000);
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

  // ── Certificate settings modal ───────────────────────────────
  const certModalBackdrop = document.getElementById('cert-modal-backdrop');
  const certModalBody     = document.getElementById('cert-modal-body');

  function openCertModal() {
    certModalBackdrop.classList.remove('hidden');

    if (window.location.protocol !== 'https:') {
      certModalBody.innerHTML =
        '<p style="font-size:13px;line-height:1.6;color:#a6adc8;margin-bottom:8px;">' +
          'The proxy is running over <strong>HTTP</strong>. No certificate is available.' +
        '</p>' +
        '<p style="font-size:12px;color:#6c7086;line-height:1.5;">' +
          'Restart the proxy with TLS enabled to generate a certificate that can be exported.' +
        '</p>';
      return;
    }

    certModalBody.innerHTML =
      '<p style="font-size:13px;line-height:1.6;color:#a6adc8;margin-bottom:12px;">' +
        'The proxy is running over <strong>HTTPS</strong> with a self-signed certificate.<br>' +
        'Export and install the certificate in your OS / browser trust store to resolve ' +
        'Service Worker SSL errors.' +
      '</p>' +
      '<div style="margin-bottom:14px;">' +
        '<button class="btn btn-primary" id="btn-download-cert-action"><svg class="icon" viewBox="0 0 24 24" style="fill:currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7ZM5 18v2h14v-2H5Z"/></svg> Export Certificate (PEM)</button>' +
      '</div>' +
      '<div style="font-size:11px;color:#6c7086;line-height:1.9;">' +
        '<strong style="color:#89b4fa;">Linux — Debian/Ubuntu (system-wide):</strong><br>' +
        '<code style="background:#313244;padding:2px 5px;border-radius:3px;">' +
          'sudo cp lengcat-vst-ca.pem /usr/local/share/ca-certificates/lengcat-vst.crt &amp;&amp; sudo update-ca-certificates' +
        '</code><br>' +
        '<strong style="color:#89b4fa;">Linux — RHEL/Fedora/CentOS (system-wide):</strong><br>' +
        '<code style="background:#313244;padding:2px 5px;border-radius:3px;">' +
          'sudo cp lengcat-vst-ca.pem /etc/pki/ca-trust/source/anchors/lengcat-vst.pem &amp;&amp; sudo update-ca-trust' +
        '</code><br>' +
        '<strong style="color:#89b4fa;">macOS:</strong><br>' +
        '<code style="background:#313244;padding:2px 5px;border-radius:3px;">' +
          'sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain lengcat-vst-ca.pem' +
        '</code><br>' +
        '<strong style="color:#89b4fa;">Windows:</strong><br>' +
        'Double-click the <code style="background:#313244;padding:2px 4px;border-radius:3px;">.pem</code> file → ' +
        'Install Certificate → Local Machine → Trusted Root Certification Authorities' +
      '</div>';

    document.getElementById('btn-download-cert-action').addEventListener('click', () => {
      window.location.href = '/api/tls/cert';
    });
  }
  function closeCertModal() {
    certModalBackdrop.classList.add('hidden');
  }
  document.getElementById('btn-cert-settings').addEventListener('click', openCertModal);
  document.getElementById('btn-close-cert-modal').addEventListener('click', closeCertModal);
  certModalBackdrop.addEventListener('click', e => { if (e.target === certModalBackdrop) closeCertModal(); });

  // ── Keyboard: Escape closes modals ──────────────────────────
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (!modalBackdrop.classList.contains('hidden')) closeNewModal();
      if (!launchModalBackdrop.classList.contains('hidden')) closeLaunchModal();
      if (!certModalBackdrop.classList.contains('hidden')) closeCertModal();
    }
  });

  // ── leduo-patrol → VS Code bridge (postMessage) ──────────────
  // Listens for messages from leduo-patrol iframes requesting to open a
  // folder in a VS Code session.  The /api/sessions/open-folder endpoint
  // either finds an existing running VS Code session for that folder or
  // creates and launches a new one with the next available port.
  window.addEventListener('message', async function(e) {
    if (!e.data || e.data.type !== 'lvst:open-folder') return;
    var folder = typeof e.data.folder === 'string' ? e.data.folder.trim() : '';
    if (!folder) return;
    try {
      var session = await apiFetch('/api/sessions/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: folder }),
      });
      if (session && session.id) {
        await fetchSessions();
        selectSession(session.id);
      }
    } catch (_) { /* error already shown by apiFetch */ }
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
      btnToggle.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>';
      btnToggle.title = 'Expand sidebar';
    } else {
      sidebar.classList.remove('collapsed');
      btnToggle.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
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

  // ── Light / dark theme toggle ─────────────────────────────────
  const btnToggleTheme = document.getElementById('btn-toggle-theme');
  function setTheme(light) {
    document.body.classList.toggle('theme-light', light);
    btnToggleTheme.innerHTML = light
      ? '<svg class="icon icon-lg" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1Z"/></svg>'
      : '<svg class="icon icon-lg" viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-3a1 1 0 0 0 1-1V1a1 1 0 1 0-2 0v2a1 1 0 0 0 1 1Zm0 18a1 1 0 0 0-1 1v2a1 1 0 1 0 2 0v-2a1 1 0 0 0-1-1ZM5.64 7.05 4.22 5.64a1 1 0 0 1 1.41-1.41l1.41 1.41a1 1 0 1 1-1.41 1.41Zm12.73 9.9a1 1 0 0 0-1.41 1.41l1.41 1.41a1 1 0 0 0 1.41-1.41l-1.41-1.41ZM4 12a1 1 0 0 0-1-1H1a1 1 0 1 0 0 2h2a1 1 0 0 0 1-1Zm18 0a1 1 0 0 0 1 1h2a1 1 0 1 0 0-2h-2a1 1 0 0 0-1 1ZM5.64 16.95a1 1 0 0 0-1.41 0l-1.41 1.41a1 1 0 0 0 1.41 1.41l1.41-1.41a1 1 0 0 0 0-1.41Zm12.73-9.9a1 1 0 0 0 1.41 0l1.41-1.41a1 1 0 0 0-1.41-1.41l-1.41 1.41a1 1 0 0 0 0 1.41Z"/></svg>';
    btnToggleTheme.title = light ? 'Switch to dark mode' : 'Switch to light mode';
    try { localStorage.setItem('theme-light', String(light)); } catch (_) {}
  }
  btnToggleTheme.addEventListener('click', () => {
    setTheme(!document.body.classList.contains('theme-light'));
  });
  try {
    if (localStorage.getItem('theme-light') === 'true') setTheme(true);
  } catch (_) {}

  // ── Touch mode toggle ─────────────────────────────────────────
  const btnToggleTouch = document.getElementById('btn-toggle-touch');
  function setTouchMode(on) {
    document.body.classList.toggle('touch-mode', on);
    btnToggleTouch.title = on ? 'Disable touch mode' : 'Enable touch mode';
    btnToggleTouch.style.opacity = on ? '1' : '0.6';
    try { localStorage.setItem('touch-mode', String(on)); } catch (_) {}
  }
  btnToggleTouch.addEventListener('click', () => {
    setTouchMode(!document.body.classList.contains('touch-mode'));
  });
  // Auto-detect touch-screen on first visit; respect saved preference otherwise.
  try {
    const saved = localStorage.getItem('touch-mode');
    if (saved !== null) {
      setTouchMode(saved === 'true');
    } else {
      const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      if (hasTouch) setTouchMode(true);
    }
  } catch (_) {}

  // ── Init ─────────────────────────────────────────────────────
  fetchSessions().then(startPolling);
})();
</script>
</body>
</html>`;
}
