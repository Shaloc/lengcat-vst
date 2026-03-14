import {
  defaultConfig,
  buildBackendConfig,
  loadConfig,
  mergeConfig,
} from '../src/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('defaultConfig', () => {
  it('returns expected defaults', () => {
    const cfg = defaultConfig();
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(3000);
    expect(cfg.auth).toBe(false);
    expect(cfg.backends).toHaveLength(1);
    expect(cfg.backends[0].type).toBe('vscode');
  });
});

describe('buildBackendConfig', () => {
  it('fills defaults for vscode', () => {
    const bc = buildBackendConfig({ type: 'vscode' });
    expect(bc.host).toBe('localhost');
    expect(bc.port).toBe(8000);
    expect(bc.tls).toBe(false);
    expect(bc.tokenSource).toBe('none');
  });

  it('overrides defaults with provided values', () => {
    const bc = buildBackendConfig({
      type: 'custom',
      host: '10.0.0.1',
      port: 9000,
      tls: true,
      tokenSource: 'fixed',
      token: 'secret',
      executable: '/usr/local/bin/mycode',
    });
    expect(bc.host).toBe('10.0.0.1');
    expect(bc.port).toBe(9000);
    expect(bc.tls).toBe(true);
    expect(bc.token).toBe('secret');
    expect(bc.executable).toBe('/usr/local/bin/mycode');
  });

  it('stores pathPrefix when provided', () => {
    const bc = buildBackendConfig({
      type: 'vscode',
      pathPrefix: '/instance/1',
    });
    expect(bc.pathPrefix).toBe('/instance/1');
  });

  it('pathPrefix is undefined when not provided', () => {
    const bc = buildBackendConfig({ type: 'vscode' });
    expect(bc.pathPrefix).toBeUndefined();
  });

  it('fills defaults for leduoPatrol', () => {
    const bc = buildBackendConfig({ type: 'leduoPatrol' });
    expect(bc.host).toBe('localhost');
    expect(bc.port).toBe(3001);
    expect(bc.tls).toBe(false);
    expect(bc.tokenSource).toBe('none');
  });
});

describe('mergeConfig', () => {
  it('merges partial config with defaults', () => {
    const cfg = mergeConfig({ port: 4000, auth: true, proxySecret: 'abc' });
    expect(cfg.port).toBe(4000);
    expect(cfg.auth).toBe(true);
    expect(cfg.proxySecret).toBe('abc');
    expect(cfg.host).toBe('127.0.0.1');
  });

  it('merges backend list', () => {
    const cfg = mergeConfig({
      backends: [{ type: 'vscode', host: 'remotehost', port: 9090, tls: false, tokenSource: 'none' }],
    });
    expect(cfg.backends[0].type).toBe('vscode');
    expect(cfg.backends[0].host).toBe('remotehost');
    expect(cfg.backends[0].port).toBe(9090);
  });
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-proxy-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid config file', () => {
    const configData = {
      port: 5000,
      auth: false,
      backends: [{ type: 'vscode', port: 8888 }],
    };
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(configData));

    const cfg = loadConfig(configPath);
    expect(cfg.port).toBe(5000);
    expect(cfg.backends[0].type).toBe('vscode');
    expect(cfg.backends[0].port).toBe(8888);
  });

  it('throws if file does not exist', () => {
    expect(() => loadConfig('/nonexistent/config.json')).toThrow(
      'Config file not found'
    );
  });

  it('throws on invalid JSON', () => {
    const configPath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(configPath, 'not json');
    expect(() => loadConfig(configPath)).toThrow('Failed to parse config file');
  });
});
