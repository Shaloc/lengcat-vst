#!/usr/bin/env node
/**
 * CLI entry point for the lengcat-vst local tunnel proxy.
 *
 * Usage:
 *   lengcat-vst [options]
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
 */

import { Command } from 'commander';
import { loadConfig, mergeConfig, BackendType, TunnelConfig, PartialBackendConfig } from './config';
import { createTunnelServer } from './server';
import { SessionManager } from './session';
import { loadOrGenerateTls, tlsCertCachePath } from './tls';

const program = new Command();

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
    '--launch',
    'automatically start each configured backend VS Code/VSCodium server'
  );

program.parse(process.argv);
const opts = program.opts<{
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
  https: boolean;        // commander turns --no-https into https: false
  tlsCert?: string;
  tlsKey?: string;
  launch?: boolean;
}>();

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
      backends: [backendEntry],
    });
  }

  // Build a session manager so the dashboard (/_ui) is always available.
  const sessionMgr = new SessionManager();
  for (const backend of config.backends) {
    sessionMgr.register(backend);
  }

  // --launch: automatically spawn each configured backend.
  if (opts.launch) {
    for (const session of sessionMgr.list()) {
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
    tlsCreds = await loadOrGenerateTls(
      opts.tlsCert ?? config.tlsCert,
      opts.tlsKey  ?? config.tlsKey
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
  if (opts.launch) {
    console.log('  Backend auto-launch: ENABLED');
  }
}

main().catch((err: Error) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
