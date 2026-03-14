/**
 * Configuration types and loading for the VS Code local tunnel proxy.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Supported backend types. */
export type BackendType = 'vscode' | 'custom' | 'leduoPatrol';

/** Connection token source. */
export type TokenSource = 'auto' | 'none' | 'fixed';

/** Configuration for a single backend VS Code server. */
export interface BackendConfig {
  /** Backend type. Defaults to 'vscode'. */
  type: BackendType;
  /**
   * Host of the backend server.
   * Use 'localhost' for a locally running server (default).
   */
  host: string;
  /** Port the backend VS Code server listens on. */
  port: number;
  /**
   * Whether the backend uses HTTPS/WSS.
   * Set true only if the backend itself is TLS-terminated.
   */
  tls: boolean;
  /**
   * Connection token required by the VS Code server.
   * 'auto' reads from the server process output (only if `managed` is true),
   * 'none' disables token verification,
   * 'fixed' uses the value in `token`.
   */
  tokenSource: TokenSource;
  /** Fixed token value when tokenSource is 'fixed'. */
  token?: string;
  /**
   * Custom executable path override (for 'custom' type or non-standard installs).
   */
  executable?: string;
  /**
   * URL path prefix for this backend instance, used for multi-instance routing.
   * When set, the proxy routes requests whose URL starts with this prefix to
   * this backend.  The backend should also be started with the matching
   * --server-base-path flag (handled automatically by resolveExecutable).
   * Example: '/instance/1'
   */
  pathPrefix?: string;
  /**
   * Local filesystem path to open as the default workspace / folder.
   * When set, the folder is appended as a `?folder=<path>` query parameter in
   * the iframe URL shown by the dashboard.
   * Example: '/home/user/my-project'
   */
  folder?: string;
  /**
   * When true the backend binary is an extension-host-only server (e.g. the
   * `code-server` binary installed by VS Code Remote-SSH at
   * `~/.vscode-server/bin/<hash>/bin/code-server`).  In this mode the proxy
   * does NOT pass the `serve-web` subcommand — the binary already IS the
   * server.  HTTP + WebSocket are still forwarded as normal, so the browser
   * can reach the VS Code web workbench served by the binary.
   */
  extensionHostOnly?: boolean;
}

/** Top-level configuration for the local tunnel proxy. */
export interface TunnelConfig {
  /** Host to bind the local proxy on. Defaults to '127.0.0.1' (loopback only). */
  host: string;
  /** Port to bind the local proxy on. Defaults to 3000. */
  port: number;
  /**
   * Whether to require an access token on the proxy itself (independent of
   * the backend token). Prevents other local processes from accessing the
   * tunnelled editor.
   */
  auth: boolean;
  /**
   * Secret used to authenticate requests arriving at the proxy.
   * Only relevant when `auth` is true.  Sent as a Bearer token in the
   * Authorization header or as the `token` query-string parameter.
   */
  proxySecret?: string;
  /** Back-end VS Code server(s) to proxy to. */
  backends: BackendConfig[];
  /**
   * Enable HTTPS on the proxy.  When true the proxy serves TLS-encrypted
   * HTTP/WebSocket so that browsers grant the page a "secure context"
   * (required by some VS Code extensions, e.g. clipboard, camera).
   *
   * Defaults to `false` for backwards compatibility; set to `true` (or use
   * the `--https` CLI flag) to enable.
   */
  https?: boolean;
  /**
   * Path to a PEM-encoded TLS certificate file.
   * Only used when `https` is true.  If omitted a self-signed certificate is
   * auto-generated and cached in `$TMPDIR/lengcat-vst-tls/`.
   */
  tlsCert?: string;
  /**
   * Path to a PEM-encoded TLS private-key file.
   * Only used when `https` is true.  Must be provided together with `tlsCert`.
   */
  tlsKey?: string;
  /**
   * Extra hostnames or IP addresses to include in the auto-generated
   * self-signed TLS certificate's Subject Alternative Names.
   *
   * Useful when the proxy is accessed via a custom domain (e.g.
   * `mydev.company.internal`) rather than `localhost`.  Ignored when
   * `tlsCert` / `tlsKey` are provided (user-supplied certificates are used
   * as-is).
   *
   * Example: `["mydev.company.internal", "10.0.1.5"]`
   */
  tlsDomains?: string[];
  /**
   * Password required to access the dashboard and proxied sessions via the
   * browser.  When set, visitors are redirected to a `/_login` form and must
   * enter the correct password before a session cookie is issued.
   *
   * This is independent of `proxySecret` / `auth` (which use Bearer-token
   * authentication and apply to all requests).  Use `dashboardPassword` for
   * a convenient browser-friendly login and `proxySecret` for API-level
   * protection.
   */
  dashboardPassword?: string;
}

/** Default port per backend type. */
const DEFAULT_PORTS: Record<BackendType, number> = {
  vscode: 8000,
  custom: 8000,
  leduoPatrol: 3001,
};

/**
 * Builds a BackendConfig with sensible defaults applied.
 * Caller-supplied values override the defaults.
 */
export function buildBackendConfig(partial: Partial<BackendConfig> & { type: BackendType }): BackendConfig {
  return {
    host: 'localhost',
    port: DEFAULT_PORTS[partial.type],
    tls: false,
    tokenSource: 'none',
    ...partial,
  };
}

/** Default tunnel configuration. */
export function defaultConfig(): TunnelConfig {
  return {
    host: '127.0.0.1',
    port: 3000,
    auth: false,
    backends: [buildBackendConfig({ type: 'vscode' })],
  };
}

/** Partial backend config as accepted by mergeConfig and loadConfig. */
export type PartialBackendConfig = Partial<BackendConfig> & { type?: BackendType };

/** Partial tunnel config as accepted by mergeConfig and loadConfig. */
export type PartialTunnelConfig = Omit<Partial<TunnelConfig>, 'backends'> & {
  backends?: PartialBackendConfig[];
};

/**
 * Loads tunnel configuration from a JSON file.
 * Missing fields are filled with defaults.
 *
 * @param configPath - Absolute or relative path to the JSON config file.
 */
export function loadConfig(configPath: string): TunnelConfig {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse config file ${resolved}: ${(err as Error).message}`);
  }

  return mergeConfig(raw as PartialTunnelConfig);
}

/**
 * Merges a partial configuration object with defaults.
 */
export function mergeConfig(partial: PartialTunnelConfig): TunnelConfig {
  const defaults = defaultConfig();
  const merged: TunnelConfig = {
    ...defaults,
    ...partial,
    backends: [],
  };

  const rawBackends = partial.backends ?? defaults.backends;
  merged.backends = rawBackends.map((b) =>
    buildBackendConfig({ ...b, type: b.type ?? 'vscode' })
  );

  return merged;
}
