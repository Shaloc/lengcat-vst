/**
 * Unit tests for the UI dashboard template (src/ui.ts).
 */

import { renderDashboard } from '../src/ui';

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

  it('contains the toolbar action buttons', () => {
    expect(html).toContain('id="btn-launch"');
    expect(html).toContain('id="btn-stop"');
    expect(html).toContain('id="btn-remove"');
  });

  it('contains the sidebar toggle button', () => {
    expect(html).toContain('id="btn-toggle-sidebar"');
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
});
