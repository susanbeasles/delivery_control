import { spawn } from 'node:child_process';

/**
 * Runs one tool with an explicit, minimal environment (nothing is inherited), in its own process
 * group so the whole tree can be stopped at the deadline. Its stdout is either captured (bounded)
 * or forwarded to our stderr; it can never reach our stdout, which carries only the result.
 */

const GRACE_MS = 10_000;

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string,string>, deadlineMs: number, captureBytes?: number, label?: string }} options
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: Buffer|null, timedOut: boolean, overflow: boolean }>}
 */
export function runTool(command, args, options) {
  return new Promise((resolve) => {
    const capture = options.captureBytes ?? 0;
    const label = options.label ?? command.split('/').pop();
    process.stderr.write(`[agent] run ${label} ${args.filter((a) => !a.includes('=')).slice(0, 3).join(' ')}\n`);
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const chunks = [];
    let size = 0;
    let overflow = false;
    let timedOut = false;
    let killTimer = null;

    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already exited
        }
      }
    };
    // SIGTERM first: OpenTofu finishes in-flight operations and persists state on interrupt.
    const stop = () => {
      signalGroup('SIGTERM');
      killTimer ??= setTimeout(() => signalGroup('SIGKILL'), GRACE_MS);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      process.stderr.write(`[agent] ${label} reached the job deadline; stopping it\n`);
      stop();
    }, Math.max(0, options.deadlineMs - Date.now()));

    child.stdout.on('data', (data) => {
      if (capture === 0) {
        process.stderr.write(data);
        return;
      }
      size += data.length;
      if (size > capture) {
        overflow = true;
        stop();
        return;
      }
      chunks.push(data);
    });
    child.stderr.on('data', (data) => process.stderr.write(data));
    child.on('error', () => {
      clearTimeout(deadline);
      resolve({ code: null, signal: null, stdout: null, timedOut, overflow });
    });
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, signal, stdout: capture > 0 && !overflow ? Buffer.concat(chunks) : null, timedOut, overflow });
    });
  });
}
