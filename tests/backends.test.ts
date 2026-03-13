import * as os from 'os';
import * as path from 'path';
import { resolveExecutable, backendOrigin, buildCodeServerArgs } from '../src/backends';
import { buildBackendConfig } from '../src/config';

describe('resolveExecutable', () => {
  it('resolves vscode executable', () => {
    const config = buildBackendConfig({ type: 'vscode', port: 8000 });
    const { command, args } = resolveExecutable(config);
    expect(command).toBe('code');
    expect(args).toContain('serve-web');
    expect(args).toContain('--port');
    expect(args).toContain('8000');
  });

  it('uses custom executable path', () => {
    const config = buildBackendConfig({
      type: 'custom',
      executable: '/opt/myide/bin/myide',
    });
    const { command } = resolveExecutable(config);
    expect(command).toBe('/opt/myide/bin/myide');
  });

  it('throws if custom type has no executable', () => {
    const config = buildBackendConfig({ type: 'custom' });
    expect(() => resolveExecutable(config)).toThrow(
      'BackendConfig.executable must be set'
    );
  });

  it('includes --without-connection-token when tokenSource is none', () => {
    const config = buildBackendConfig({ type: 'vscode', tokenSource: 'none' });
    const { args } = resolveExecutable(config);
    expect(args).toContain('--without-connection-token');
    expect(args).not.toContain('--connection-token');
  });

  it('uses --connection-token when tokenSource is fixed', () => {
    const config = buildBackendConfig({
      type: 'vscode',
      tokenSource: 'fixed',
      token: 'mytoken',
    });
    const { args } = resolveExecutable(config);
    expect(args).toContain('--connection-token');
    expect(args).toContain('mytoken');
    expect(args).not.toContain('--without-connection-token');
  });

  it('includes --server-base-path when pathPrefix is set', () => {
    const config = buildBackendConfig({
      type: 'vscode',
      pathPrefix: '/instance/1',
    });
    const { args } = resolveExecutable(config);
    expect(args).toContain('--server-base-path');
    expect(args).toContain('/instance/1');
  });

  it('does not include --server-base-path when pathPrefix is not set', () => {
    const config = buildBackendConfig({ type: 'vscode' });
    const { args } = resolveExecutable(config);
    expect(args).not.toContain('--server-base-path');
  });

  it('omits serve-web subcommand when extensionHostOnly is true', () => {
    const config = buildBackendConfig({ type: 'vscode', extensionHostOnly: true });
    const { args } = resolveExecutable(config);
    expect(args[0]).not.toBe('serve-web');
    // Must still contain the port/host flags
    expect(args).toContain('--host');
    expect(args).toContain('--port');
  });

  it('includes serve-web subcommand when extensionHostOnly is false', () => {
    const config = buildBackendConfig({ type: 'vscode', extensionHostOnly: false });
    const { args } = resolveExecutable(config);
    expect(args[0]).toBe('serve-web');
  });
});

describe('buildCodeServerArgs', () => {
  it('uses --bind-addr with combined host:port', () => {
    const config = buildBackendConfig({ type: 'vscode', host: '127.0.0.1', port: 8080 });
    const args = buildCodeServerArgs(config);
    expect(args).toContain('--bind-addr');
    expect(args).toContain('127.0.0.1:8080');
  });

  it('normalises localhost to 127.0.0.1 in bind-addr', () => {
    const config = buildBackendConfig({ type: 'vscode', host: 'localhost', port: 8080 });
    const args = buildCodeServerArgs(config);
    expect(args).toContain('127.0.0.1:8080');
  });

  it('uses --auth none', () => {
    const config = buildBackendConfig({ type: 'vscode', port: 8080 });
    const args = buildCodeServerArgs(config);
    expect(args).toContain('--auth');
    expect(args).toContain('none');
  });

  it('includes --user-data-dir ($HOME/.vscode-server/data) and per-session --extensions-dir', () => {
    const config = buildBackendConfig({ type: 'vscode', port: 8080 });
    const args = buildCodeServerArgs(config);
    expect(args).toContain('--user-data-dir');
    expect(args).toContain('--extensions-dir');
  });

  it('uses $HOME/.vscode-server/data as shared user-data-dir', () => {
    const config = buildBackendConfig({ type: 'vscode', port: 8080 });
    const args = buildCodeServerArgs(config);
    const idx = args.indexOf('--user-data-dir');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(path.join(os.homedir(), '.vscode-server', 'data'));
  });

  it('uses a per-session extensions-dir under .lengcat-vst/sessions', () => {
    const config = buildBackendConfig({ type: 'vscode', host: '127.0.0.1', port: 8080 });
    const args = buildCodeServerArgs(config);
    const idx = args.indexOf('--extensions-dir');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toContain('127.0.0.1-8080');
    expect(args[idx + 1]).toContain('extensions');
  });

  it('does not include --base-path (code-server has no base-path flag; stripping is handled by the proxy)', () => {
    const config = buildBackendConfig({ type: 'vscode', port: 8080, pathPrefix: '/instance/1' });
    const args = buildCodeServerArgs(config);
    expect(args).not.toContain('--base-path');
    expect(args).not.toContain('/instance/1');
  });

  it('args are the same regardless of pathPrefix (prefix stripping is proxy-side)', () => {
    const withPrefix = buildBackendConfig({ type: 'vscode', port: 8080, pathPrefix: '/instance/1' });
    const withoutPrefix = buildBackendConfig({ type: 'vscode', port: 8080 });
    const argsWith = buildCodeServerArgs(withPrefix);
    const argsWithout = buildCodeServerArgs(withoutPrefix);
    // pathPrefix doesn't affect code-server args — only the proxy config differs
    expect(argsWith.filter(a => !a.includes('lengcat-vst'))).toEqual(
      argsWithout.filter(a => !a.includes('lengcat-vst'))
    );
  });
});

describe('backendOrigin', () => {
  it('returns http origin for non-tls backend', () => {
    const config = buildBackendConfig({ type: 'vscode', host: 'localhost', port: 8000, tls: false });
    expect(backendOrigin(config)).toBe('http://localhost:8000');
  });

  it('returns https origin for tls backend', () => {
    const config = buildBackendConfig({ type: 'vscode', host: 'myserver', port: 443, tls: true });
    expect(backendOrigin(config)).toBe('https://myserver:443');
  });
});
