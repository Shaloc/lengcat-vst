/**
 * WebSocket-based terminal for the onboarding shell.
 *
 * Spawns an interactive bash session wrapped in the `script` command so
 * that a real PTY is allocated.  This gives us proper ANSI escape sequences
 * and terminal behaviour (colours, progress bars, line editing) without
 * requiring native modules like `node-pty`.
 *
 * The WebSocket protocol is simple:
 *   - Client → Server:  raw text (user keystrokes)
 *   - Server → Client:  raw text (terminal output)
 *   - Server → Client:  JSON `{"type":"exit","code":<n>}` when the shell exits
 */

import { ChildProcess, spawn } from 'child_process';
import * as os from 'os';

export interface TerminalSession {
  /** The underlying shell process. */
  process: ChildProcess;
  /** Write user input to the shell's stdin. */
  write(data: string): void;
  /** Register a callback for terminal output. */
  onData(cb: (data: string) => void): void;
  /** Register a callback for process exit. */
  onExit(cb: (code: number | null) => void): void;
  /** Kill the terminal session. */
  kill(): void;
}

/**
 * Creates a new interactive terminal session.
 *
 * On Linux, uses `script -qefc 'bash -i' /dev/null` to allocate a PTY.
 * On macOS, uses `script -q /dev/null bash -i`.
 *
 * @param cwd  Working directory for the shell (defaults to $HOME).
 * @param env  Additional environment variables.
 */
export function createTerminalSession(
  cwd?: string,
  env?: Record<string, string>
): TerminalSession {
  const shellEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };

  const workDir = cwd ?? os.homedir();

  let proc: ChildProcess;
  if (process.platform === 'darwin') {
    // macOS: script -q /dev/null bash -i
    proc = spawn('script', ['-q', '/dev/null', 'bash', '-i'], {
      cwd: workDir,
      env: shellEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    // Linux: script -qfc 'bash -i' /dev/null
    // -q: quiet (suppress start/done messages)
    // -f: flush output after each write (important for real-time terminal)
    // -c: execute command
    proc = spawn('script', ['-qfc', 'bash -i', '/dev/null'], {
      cwd: workDir,
      env: shellEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(code: number | null) => void> = [];

  if (proc.stdout) {
    proc.stdout.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf-8');
      for (const cb of dataCallbacks) cb(str);
    });
  }
  if (proc.stderr) {
    proc.stderr.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf-8');
      for (const cb of dataCallbacks) cb(str);
    });
  }
  proc.on('exit', (code) => {
    for (const cb of exitCallbacks) cb(code);
  });

  // Absorb errors so they don't crash the Node.js process.
  proc.on('error', (err) => {
    process.stderr.write(
      `[lengcat-vst] terminal process error: ${err.message}\n`
    );
  });

  return {
    process: proc,
    write(data: string) {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(data);
      }
    },
    onData(cb) {
      dataCallbacks.push(cb);
    },
    onExit(cb) {
      exitCallbacks.push(cb);
    },
    kill() {
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    },
  };
}
