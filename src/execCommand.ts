import { K8s } from '@kinvolk/headlamp-plugin/lib';

type Pod = InstanceType<typeof K8s.ResourceClasses.Pod>;

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** True when Kubernetes reported the command finished successfully. */
  ok: boolean;
  /** Error message from Kubernetes (e.g. "executable file not found"). */
  error?: string;
}

// Kubernetes exec websocket channels: first byte of every frame.
const STDOUT = 1;
const STDERR = 2;
const STATUS = 3;

const decoder = new TextDecoder('utf-8');

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * Run a one-shot, non-interactive command in a container and collect its output.
 * Uses Headlamp's built-in pod.exec, so cluster auth and RBAC come from Headlamp.
 */
export function execCommand(
  pod: Pod,
  container: string,
  command: string[],
  timeoutMs = 15000
): Promise<ExecResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    let handle: { cancel: () => void } | null = null;

    const finish = (result: ExecResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        handle?.cancel();
      } catch {
        // socket already closed
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ stdout, stderr, ok: false, error: 'Timed out waiting for the container.' }),
      timeoutMs
    );

    const onData = (data: unknown) => {
      const bytes = toBytes(data);
      if (!bytes || bytes.length === 0) return;
      const channel = bytes[0];
      const text = decoder.decode(bytes.slice(1));

      if (channel === STDOUT) {
        stdout += text;
      } else if (channel === STDERR) {
        stderr += text;
      } else if (channel === STATUS) {
        // Final status frame: {"status":"Success"} or {"status":"Failure","message":...}
        try {
          const status = JSON.parse(text);
          if (status.status === 'Success') {
            finish({ stdout, stderr, ok: true });
          } else {
            finish({ stdout, stderr, ok: false, error: status.message || 'Command failed.' });
          }
        } catch {
          finish({ stdout, stderr, ok: false, error: text });
        }
      }
    };

    handle = pod.exec(container, onData, {
      command,
      tty: false,
      stdin: false,
      stdout: true,
      stderr: true,
      reconnectOnFailure: false,
      failCb: () =>
        finish({
          stdout,
          stderr,
          ok: stdout.length > 0 && stderr.length === 0,
          error: stdout.length > 0 ? undefined : 'Connection to the container closed.',
        }),
    });
  });
}
