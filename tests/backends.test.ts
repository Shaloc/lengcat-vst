import { resolveExecutable, backendOrigin } from '../src/backends';
import { buildBackendConfig } from '../src/config';

describe('resolveExecutable', () => {
  it('resolves vscodium executable', () => {
    const config = buildBackendConfig({ type: 'vscodium', port: 8000 });
    const { command, args } = resolveExecutable(config);
    expect(command).toBe('codium');
    expect(args).toContain('serve-web');
    expect(args).toContain('--port');
    expect(args).toContain('8000');
  });

  it('resolves vscode executable', () => {
    const config = buildBackendConfig({ type: 'vscode', port: 8000 });
    const { command } = resolveExecutable(config);
    expect(command).toBe('code');
  });

  it('resolves lingma executable', () => {
    const config = buildBackendConfig({ type: 'lingma', port: 8080 });
    const { command } = resolveExecutable(config);
    expect(command).toBe('lingma');
  });

  it('resolves qoder executable', () => {
    const config = buildBackendConfig({ type: 'qoder', port: 8080 });
    const { command } = resolveExecutable(config);
    expect(command).toBe('qoder');
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
    const config = buildBackendConfig({ type: 'vscodium', tokenSource: 'none' });
    const { args } = resolveExecutable(config);
    expect(args).toContain('--without-connection-token');
    expect(args).not.toContain('--connection-token');
  });

  it('uses --connection-token when tokenSource is fixed', () => {
    const config = buildBackendConfig({
      type: 'vscodium',
      tokenSource: 'fixed',
      token: 'mytoken',
    });
    const { args } = resolveExecutable(config);
    expect(args).toContain('--connection-token');
    expect(args).toContain('mytoken');
    expect(args).not.toContain('--without-connection-token');
  });
});

describe('backendOrigin', () => {
  it('returns http origin for non-tls backend', () => {
    const config = buildBackendConfig({ type: 'vscodium', host: 'localhost', port: 8000, tls: false });
    expect(backendOrigin(config)).toBe('http://localhost:8000');
  });

  it('returns https origin for tls backend', () => {
    const config = buildBackendConfig({ type: 'vscode', host: 'myserver', port: 443, tls: true });
    expect(backendOrigin(config)).toBe('https://myserver:443');
  });
});
