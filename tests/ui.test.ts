/**
 * Unit tests for the UI dashboard template (src/ui.ts).
 */

import { renderDashboard, renderLoginPage } from '../src/ui';

describe('renderDashboard', () => {
  let html: string;
  beforeAll(() => { html = renderDashboard(); });

  it('returns a non-empty string', () => {
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(100);
  });

  it('is a valid HTML document (starts with <!DOCTYPE html>)', () => {
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('contains the page title', () => {
    expect(html).toContain('lengcat-vst');
  });

  it('contains the session-list element', () => {
    expect(html).toContain('id="session-list"');
  });

  it('contains the new-session button', () => {
    expect(html).toContain('id="btn-new-session"');
  });

  it('contains the session-frame sentinel element (iframes are created dynamically)', () => {
    expect(html).toContain('id="session-frame"');
    // Actual iframes are created in JS with id="session-frame-{sessionId}"
    expect(html).toContain('session-frame-');
    expect(html).toContain('iframePool');
  });

  it('contains the new-session modal', () => {
    expect(html).toContain('id="modal-backdrop"');
  });

  it('contains the API URL /api/sessions in the script', () => {
    expect(html).toContain('/api/sessions');
  });

  it('references all expected backend types in the new-session form', () => {
    expect(html).toContain('value="vscode"');
    expect(html).toContain('value="custom"');
  });

  it('pins leduo-patrol session at the top of the session list in dashboard script', () => {
    expect(html).toContain("a.type === 'leduoPatrol' ? 0 : 1");
    expect(html).toContain("b.type === 'leduoPatrol' ? 0 : 1");
  });

  it('renders leduo-patrol label for leduoPatrol backend type', () => {
    expect(html).toContain("type === 'leduoPatrol' ? 'leduo-patrol' : type");
  });

  it('appends leduo access key to the iframe URL query string', () => {
    expect(html).toContain("if (s.type === 'leduoPatrol' && s.accessKey)");
    expect(html).toContain("params.set('key', s.accessKey)");
  });

  it('contains the toolbar action buttons', () => {
    expect(html).toContain('id="btn-launch"');
    expect(html).toContain('id="btn-stop"');
    expect(html).toContain('id="btn-remove"');
  });

  it('contains the sidebar toggle button', () => {
    expect(html).toContain('id="btn-toggle-sidebar"');
  });

  it('contains the certificate settings button in the sidebar footer', () => {
    expect(html).toContain('id="btn-cert-settings"');
    expect(html).toContain('id="sidebar-footer"');
  });

  it('contains the certificate settings modal', () => {
    expect(html).toContain('id="cert-modal-backdrop"');
    expect(html).toContain('id="cert-modal-body"');
    expect(html).toContain('id="btn-close-cert-modal"');
  });

  it('contains the /api/tls/cert API path in the script', () => {
    expect(html).toContain('/api/tls/cert');
  });

  it('contains the launch-with-folder modal', () => {
    expect(html).toContain('id="launch-modal-backdrop"');
    expect(html).toContain('id="launch-folder"');
    expect(html).toContain('id="btn-confirm-launch-modal"');
  });

  it('contains the extensionHostOnly checkbox in the new-session modal', () => {
    expect(html).toContain('id="new-ext-host"');
  });

  it('contains the folder input in the new-session modal', () => {
    expect(html).toContain('id="new-folder"');
  });

  it('the launch folder input name is referenced in the script', () => {
    expect(html).toContain('launch-folder');
  });

  it('contains the session-error-banner element for surfacing launch errors', () => {
    expect(html).toContain('id="session-error-banner"');
  });

  it('dashboard script references sessionErrorBanner for error display', () => {
    expect(html).toContain('sessionErrorBanner');
    expect(html).toContain('Launch error:');
  });

  it('contains the light/dark theme toggle button', () => {
    expect(html).toContain('id="btn-toggle-theme"');
  });

  it('contains the touch mode toggle button', () => {
    expect(html).toContain('id="btn-toggle-touch"');
  });

  it('uses CSS custom properties (variables) for theming', () => {
    expect(html).toContain('--c-base:');
    expect(html).toContain('var(--c-base)');
    expect(html).toContain('var(--c-accent)');
  });

  it('includes a light theme CSS override block', () => {
    expect(html).toContain('body.theme-light');
  });

  it('includes touch mode CSS rules', () => {
    expect(html).toContain('body.touch-mode');
  });

  it('dashboard script includes theme toggle logic with localStorage', () => {
    expect(html).toContain('theme-light');
    expect(html).toContain('setTheme');
    expect(html).toContain('btn-toggle-theme');
  });

  it('dashboard script includes touch mode toggle logic with localStorage', () => {
    expect(html).toContain('touch-mode');
    expect(html).toContain('setTouchMode');
    expect(html).toContain('btn-toggle-touch');
  });

  it('touch mode is auto-detected on first visit', () => {
    expect(html).toContain('maxTouchPoints');
    expect(html).toContain('ontouchstart');
  });

  it('includes an SVG favicon', () => {
    expect(html).toContain('rel="icon"');
    expect(html).toContain('type="image/svg+xml"');
  });

  it('uses inline SVG icons instead of emoji for toolbar buttons', () => {
    expect(html).toContain('class="icon');
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox=');
  });
});

describe('renderLoginPage', () => {
  it('returns valid HTML with login form', () => {
    const html = renderLoginPage();
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('action="/_login"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="password"');
  });

  it('includes a hidden next field defaulting to /', () => {
    const html = renderLoginPage(false, '/');
    expect(html).toContain('name="next"');
    expect(html).toContain('value="/"');
  });

  it('passes through the next URL into the form', () => {
    const html = renderLoginPage(false, '/api/sessions');
    expect(html).toContain('value="/api/sessions"');
  });

  it('shows error message when error=true', () => {
    const html = renderLoginPage(true);
    expect(html).toContain('Incorrect password');
  });

  it('does not show error message when error=false', () => {
    const html = renderLoginPage(false);
    expect(html).not.toContain('Incorrect password');
  });

  it('sanitises the next URL to prevent HTML injection', () => {
    const html = renderLoginPage(false, '/"><script>evil()</script>');
    expect(html).not.toContain('<script>evil()');
    expect(html).toContain('&lt;script&gt;');
  });

  it('rejects non-relative next URLs (must start with /)', () => {
    const html = renderLoginPage(false, 'https://evil.example.com');
    // Falls back to /
    expect(html).toContain('value="/"');
  });

  it('includes an SVG favicon', () => {
    const html = renderLoginPage();
    expect(html).toContain('rel="icon"');
    expect(html).toContain('type="image/svg+xml"');
  });
});
