#!/usr/bin/env node
/**
 * CLI entry point for the vscodium local tunnel proxy.
 *
 * Usage:
 *   vscodium-tunnel [options]
 *
 * Options:
 *   --config <path>       Path to JSON config file
 *   --port <port>         Local proxy port (default: 3000)
 *   --host <host>         Local proxy bind address (default: 127.0.0.1)
 *   --backend-type <t>    Backend type: vscode|vscodium|lingma|qoder|custom
 *   --backend-host <h>    Backend host (default: localhost)
 *   --backend-port <p>    Backend port
 *   --token <secret>      Enable proxy auth with this secret
 *   --no-auth             Disable proxy authentication (default when no token given)
 */

import { Command } from 'commander';
import { loadConfig, mergeConfig, BackendType, TunnelConfig, PartialBackendConfig } from './config';
import { createTunnelServer } from './server';

const program = new Command();

program
  .name('vscodium-tunnel')
  .description(
    'A private local HTTP tunnel for VS Code / VSCodium serve-web — no public cloud required.'
  )
  .version('1.0.0');

program
  .option('--config <path>', 'path to JSON configuration file')
  .option('--port <port>', 'local proxy listen port', '3000')
  .option('--host <host>', 'local proxy bind address', '127.0.0.1')
  .option(
    '--backend-type <type>',
    'backend type: vscode | vscodium | lingma | qoder | custom',
    'vscodium'
  )
  .option('--backend-host <host>', 'backend server host', 'localhost')
  .option('--backend-port <port>', 'backend server port')
  .option('--token <secret>', 'enable proxy auth; provide the secret token')
  .option(
    '--backend-token <token>',
    'fixed connection token for the backend VS Code server'
  );

program.parse(process.argv);
const opts = program.opts<{
  config?: string;
  port: string;
  host: string;
  backendType: string;
  backendHost: string;
  backendPort?: string;
  token?: string;
  backendToken?: string;
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

  const server = createTunnelServer(config);

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });

  await server.listen();

  const backend = config.backends[0];
  console.log(`vscodium-tunnel listening on http://${config.host}:${config.port}`);
  console.log(`  Proxying to ${backend.type} at ${backend.host}:${backend.port}`);
  if (config.auth) {
    console.log('  Proxy authentication: ENABLED');
  }
}

main().catch((err: Error) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
