import { resolveExecutable, backendOrigin, findServerBinaryInHomeDir } from '../src/backends';
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

describe('findServerBinaryInHomeDir', () => {
  it('returns undefined or a string (does not throw)', () => {
    // On a machine without ~/.vscode-server the function should return
    // undefined rather than throwing.
    const result = findServerBinaryInHomeDir();
    expect(typeof result === 'string' || result === undefined).toBe(true);
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
