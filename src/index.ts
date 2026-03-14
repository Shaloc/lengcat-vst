#!/usr/bin/env node
/**
 * CLI entry point for the lengcat-vst local tunnel proxy.
 *
 * Usage:
 *   lengcat-vst [options]
 *   lengcat-vst install [--version <v>] [--check]
 *
 * Options:
 *   --config <path>         Path to JSON config file
 *   --port <port>           Local proxy port (default: 3000)
 *   --host <host>           Local proxy bind address (default: 127.0.0.1)
 *   --backend-type <t>      Backend type: vscode|custom
 *   --backend-host <h>      Backend host (default: localhost)
 *   --backend-port <p>      Backend port
 *   --path-prefix <p>       Path prefix for the backend
 *   --token <secret>        Enable proxy auth with this secret
 *   --backend-token <t>     Fixed connection token for the VS Code backend
 *   --folder <path>         Workspace/folder to open in VS Code
 *   --extension-host-only   Skip the serve-web subcommand (Remote-SSH style server)
 *   --https / --no-https    Serve over HTTPS (default: true)
 *   --tls-cert <path>       Path to TLS certificate PEM file
 *   --tls-key <path>        Path to TLS private-key PEM file
 *   --launch                Auto-launch each configured backend before proxying
 *
 * Subcommands:
 *   install                 Install or update the code-server binary
 */

import { Command } from 'commander';
import { loadConfig, mergeConfig, BackendType, TunnelConfig, PartialBackendConfig, buildBackendConfig } from './config';
import { createTunnelServer } from './server';
import { SessionManager } from './session';
import { loadOrGenerateTls, tlsCertCachePath } from './tls';
import {
  ensureCodeServer,
  installedCodeServerVersion,
  fetchLatestCodeServerVersion,
  installCodeServer,
  CODE_SERVER_CACHE_DIR,
  localTarballPath,
} from './download';

const program = new Command();
const LEDUO_SESSION_PATH_PREFIX = '/_leduo-patrol';

program
  .name('lengcat-vst')
  .description(
    'A private local HTTPS tunnel for VS Code / VSCodium serve-web — no public cloud required.'
  )
  .version('1.0.0');

program
  .option('--config <path>', 'path to JSON configuration file')
  .option('--port <port>', 'local proxy listen port', '3000')
  .option('--host <host>', 'local proxy bind address', '127.0.0.1')
  .option(
    '--backend-type <type>',
    'backend type: vscode | custom',
    'vscode'
  )
  .option('--backend-host <host>', 'backend server host', 'localhost')
  .option('--backend-port <port>', 'backend server port')
  .option('--path-prefix <prefix>', 'path prefix for multi-instance routing (e.g. /instance/1)')
  .option('--token <secret>', 'enable proxy auth; provide the secret token')
  .option(
    '--backend-token <token>',
    'fixed connection token for the backend VS Code server'
  )
  .option(
    '--folder <path>',
    'workspace/folder path to open in VS Code (forwarded as a URL query param)'
  )
  .option(
    '--extension-host-only',
    'backend is an extension-host-only server (e.g. ~/.vscode-server); skips serve-web subcommand'
  )
  .option(
    '--https',
    'serve the proxy over HTTPS/WSS so the browser grants a secure context (default: on)',
    true   // default true
  )
  .option(
    '--no-https',
    'disable HTTPS and serve plain HTTP (not recommended; disables secure context)'
  )
  .option('--tls-cert <path>', 'path to TLS certificate PEM file (auto-generated if omitted)')
  .option('--tls-key <path>',  'path to TLS private-key PEM file (auto-generated if omitted)')
  .option(
    '--tls-domains <domains>',
    'comma-separated extra hostnames/IPs to include in the auto-generated TLS certificate SANs (e.g. mydev.local,10.0.1.5)'
  )
  .option(
    '--dashboard-password <password>',
    'protect the dashboard with a browser login form; visitors must enter this password'
  )
  .option(
    '--launch',
    'automatically start each configured backend VS Code/VSCodium server'
  );

// Only parse proxy options when not running the install subcommand.
if (process.argv[2] !== 'install') {
  program.parse(process.argv);
}
const opts = process.argv[2] !== 'install'
  ? program.opts<{
      config?: string;
      port: string;
      host: string;
      backendType: string;
      backendHost: string;
      backendPort?: string;
      pathPrefix?: string;
      token?: string;
      backendToken?: string;
      folder?: string;
      extensionHostOnly?: boolean;
      https: boolean;
      tlsCert?: string;
      tlsKey?: string;
      tlsDomains?: string;
      dashboardPassword?: string;
      launch?: boolean;
    }>()
  : ({} as {
      config?: string;
      port: string;
      host: string;
      backendType: string;
      backendHost: string;
      backendPort?: string;
      pathPrefix?: string;
      token?: string;
      backendToken?: string;
      folder?: string;
      extensionHostOnly?: boolean;
      https: boolean;
      tlsCert?: string;
      tlsKey?: string;
      tlsDomains?: string;
      dashboardPassword?: string;
      launch?: boolean;
    });

async function main(): Promise<void> {
  let config: TunnelConfig;

  if (opts.config) {
    config = loadConfig(opts.config);
  } else {
    const backendType = opts.backendType as BackendType;
    const backendPort = opts.backendPort
      ? parseInt(opts.backendPort, 10)
      : undefined;

    const backendEntry: PartialBackendConfig = {
      type: backendType,
      host: opts.backendHost,
      tls: false,
      tokenSource: opts.backendToken ? 'fixed' : 'none',
      token: opts.backendToken,
      pathPrefix: opts.pathPrefix,
      folder: opts.folder,
      extensionHostOnly: opts.extensionHostOnly,
    };
    if (backendPort !== undefined) {
      backendEntry.port = backendPort;
    }

    config = mergeConfig({
      host: opts.host,
      port: parseInt(opts.port, 10),
      auth: !!opts.token,
      proxySecret: opts.token,
      dashboardPassword: opts.dashboardPassword,
      backends: [backendEntry],
    });
  }

  // Build a session manager so the dashboard (/_ui) is always available.
  const sessionMgr = new SessionManager();
  const leduoPort = (() => {
    const parsed = parseInt(process.env.LEDUO_PATROL_PORT ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3001;
  })();
  const leduoHost = process.env.LEDUO_PATROL_HOST ?? '127.0.0.1';
  const leduoSession = sessionMgr.register(buildBackendConfig({
    type: 'leduoPatrol',
    host: leduoHost,
    port: leduoPort,
    tls: false,
    tokenSource: 'none',
    pathPrefix: LEDUO_SESSION_PATH_PREFIX,
  }));
  for (const backend of config.backends) {
    sessionMgr.register(backend);
  }

  // ── Onboarding: ensure code-server is installed before launching ──────────
  if (opts.launch) {
    const sep = '─'.repeat(52);
    console.log(sep);
    const installed = installedCodeServerVersion();
    if (installed) {
      console.log(`code-server v${installed} ready.`);
    } else {
      console.log('code-server not found — installing from GitHub Releases…');
      console.log(`Cache dir: ${CODE_SERVER_CACHE_DIR}`);
      await ensureCodeServer((msg) => console.log(msg));
      console.log(`code-server v${installedCodeServerVersion() ?? '?'} installed.`);
    }
    console.log(sep);
  }
  try {
    await sessionMgr.launch(leduoSession.id);
    console.log(`  Launched leduo-patrol (port ${leduoSession.port}, pid ${leduoSession.pid ?? '?'})`);
  } catch (err) {
    console.error(`  Failed to launch leduo-patrol: ${(err as Error).message}`);
  }
  if (opts.launch) {
    for (const session of sessionMgr.list()) {
      if (session.id === leduoSession.id) continue;
      try {
        await sessionMgr.launch(session.id);
        console.log(
          `  Launched ${session.type} (port ${session.port}, pid ${session.pid ?? '?'})`
        );
      } catch (err) {
        console.error(`  Failed to launch ${session.type}: ${(err as Error).message}`);
      }
    }
  }

  // ── TLS / HTTPS ──────────────────────────────────────────────────────────
  const useHttps = opts.https !== false && (config.https !== false);
  let tlsCreds: Awaited<ReturnType<typeof loadOrGenerateTls>> | undefined;
  if (useHttps) {
    // Collect extra domains for the auto-generated certificate.
    // Priority: --tls-domains flag > config.tlsDomains.
    // In addition, when the bind host is not a loopback address it is
    // automatically included so that browsers visiting the proxy via that
    // address can validate the certificate without a warning.
    const extraDomains: string[] = [];

    const cliDomains = opts.tlsDomains
      ? opts.tlsDomains.split(',').map((d) => d.trim()).filter(Boolean)
      : [];
    const cfgDomains = config.tlsDomains ?? [];
    const allExplicit = [...cliDomains, ...cfgDomains];

    // Auto-include the bind host when it is not loopback.
    const bindHost = config.host;
    const isLoopback =
      bindHost === '127.0.0.1' ||
      bindHost === 'localhost' ||
      // IPv6 loopback (full and compressed forms)
      bindHost === '::1' ||
      bindHost === '0:0:0:0:0:0:0:1' ||
      // IPv4-mapped IPv6 loopback
      bindHost === '::ffff:127.0.0.1';
    if (!isLoopback && !allExplicit.includes(bindHost)) {
      allExplicit.push(bindHost);
    }

    extraDomains.push(...allExplicit);

    tlsCreds = await loadOrGenerateTls(
      opts.tlsCert ?? config.tlsCert,
      opts.tlsKey  ?? config.tlsKey,
      extraDomains.length > 0 ? extraDomains : undefined
    );
  }

  const server = createTunnelServer(config, sessionMgr, tlsCreds);

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    sessionMgr.stopAll();
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    sessionMgr.stopAll();
    await server.close();
    process.exit(0);
  });

  await server.listen();

  const scheme = useHttps ? 'https' : 'http';
  const backend = config.backends[0];
  console.log(`lengcat-vst listening on ${scheme}://${config.host}:${config.port}`);
  if (backend) {
    console.log(`  Proxying to ${backend.type} at ${backend.host}:${backend.port}`);
  }
  console.log(`  Open ${scheme}://${config.host}:${config.port}/ in your browser to manage sessions`);
  if (useHttps && tlsCreds?.selfSigned) {
    console.log(`  TLS: self-signed certificate (accept the browser warning once)`);
    console.log(`  Cert cached at: ${tlsCertCachePath}`);
  }
  if (config.auth) {
    console.log('  Proxy authentication: ENABLED');
  }
  if (config.dashboardPassword) {
    console.log('  Dashboard password protection: ENABLED (login at /_login)');
  }
  if (opts.launch) {
    console.log('  Backend auto-launch: ENABLED');
  }
}

// ── install subcommand ────────────────────────────────────────────────────────
/**
 * Handles `lengcat-vst install [--version <v>] [--check]`.
 *
 * --check : query GitHub for the latest version and report whether an update
 *           is available; does NOT install anything.
 * --version: install a specific version instead of the latest.
 *
 * Offline / poor-network usage:
 *   If the download fails, the tool prints the exact tarball URL and the path
 *   where you should place it.  Download the file on another machine and copy
 *   it into CODE_SERVER_CACHE_DIR; the tool will detect and extract it
 *   automatically on the next run.
 */
async function runInstallCommand(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const versionIdx = process.argv.indexOf('--version');
  const requestedVersion = versionIdx >= 0 ? process.argv[versionIdx + 1] : undefined;

  const installed = installedCodeServerVersion();
  const sep = '─'.repeat(52);

  console.log('code-server installation');
  console.log(sep);
  console.log(`  Cache dir : ${CODE_SERVER_CACHE_DIR}`);
  console.log(`  Installed : ${installed ? `v${installed}` : '(none)'}`);

  if (checkOnly) {
    console.log('  Fetching latest version from GitHub…');
    const latest = await fetchLatestCodeServerVersion();
    console.log(`  Latest    : v${latest}`);
    if (installed === latest) {
      console.log('  ✓ Already up to date.');
    } else if (installed) {
      console.log(`  ↑ Update available: v${installed} → v${latest}`);
      console.log('  Run `lengcat-vst install` to update.');
    } else {
      console.log(`  Run \`lengcat-vst install\` to install v${latest}.`);
    }
    console.log(sep);
    return;
  }

  let version = requestedVersion;
  if (!version) {
    console.log('  Fetching latest version from GitHub…');
    version = await fetchLatestCodeServerVersion();
    console.log(`  Latest    : v${version}`);
  }

  if (installed === version) {
    console.log(`  ✓ code-server v${version} is already installed.`);
    console.log(sep);
    return;
  }

  console.log(`  Installing v${version}…`);
  console.log(`  Tip: if the download is slow or fails, place the tarball at:`);
  console.log(`       ${localTarballPath(version)}`);
  console.log(sep);

  await installCodeServer(version, (msg) => console.log(msg));

  console.log(sep);
  console.log(`  ✓ code-server v${version} installed.`);
  console.log(sep);
}

// ── entry-point dispatch ─────────────────────────────────────────────────────

if (process.argv[2] === 'install') {
  runInstallCommand()
    .then(() => process.exit(0))
    .catch((err: Error) => {
      console.error(`Install failed: ${err.message}`);
      process.exit(1);
    });
} else {
  main().catch((err: Error) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
