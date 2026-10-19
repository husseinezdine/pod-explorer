import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { execCommand, ExecResult } from './execCommand';

type Pod = InstanceType<typeof K8s.ResourceClasses.Pod>;

/**
 * Base64 characters sent per exec call. Content travels as a command argument
 * (in the exec URL), so it is split into chunks to stay well under URL limits.
 */
const CHUNK_SIZE = 32 * 1024;

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Script arguments are passed as $1, $2 … so names are never interpreted by the shell. */
function sh(pod: Pod, container: string, script: string, ...args: string[]) {
  return execCommand(pod, container, ['sh', '-c', script, 'sh', ...args], 30000);
}

/** Create an empty file. Fails if something already exists at that path. */
export function createFile(pod: Pod, container: string, path: string): Promise<ExecResult> {
  return sh(
    pod,
    container,
    'if [ -e "$1" ]; then echo "A file or folder with this name already exists." >&2; exit 1; fi; : > "$1"',
    path
  );
}

/** Create a folder. Fails if something already exists at that path. */
export function createFolder(pod: Pod, container: string, path: string): Promise<ExecResult> {
  return sh(
    pod,
    container,
    'if [ -e "$1" ]; then echo "A file or folder with this name already exists." >&2; exit 1; fi; mkdir -- "$1"',
    path
  );
}

/**
 * Overwrite a file with new text content.
 *
 * Content is written to a temp file next to the target in base64 chunks, then
 * copied over the target with `cat >` so the original file keeps its owner,
 * permissions and inode (symlinks and mounted ConfigMap files keep working).
 */
export async function writeFile(
  pod: Pod,
  container: string,
  path: string,
  content: string
): Promise<ExecResult> {
  const encoded = toBase64(content);
  const slash = path.lastIndexOf('/');
  const tmp = `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}.pod-explorer.tmp`;

  // Start with an empty temp file, then append each chunk.
  let result = await sh(pod, container, ': > "$1"', tmp);
  if (!result.ok) return result;

  for (let i = 0; i < encoded.length; i += CHUNK_SIZE) {
    result = await sh(
      pod,
      container,
      'printf %s "$1" | base64 -d >> "$2"',
      encoded.slice(i, i + CHUNK_SIZE),
      tmp
    );
    if (!result.ok) {
      await sh(pod, container, 'rm -f -- "$1"', tmp);
      return result;
    }
  }

  return sh(
    pod,
    container,
    'cat -- "$1" > "$2"; status=$?; rm -f -- "$1"; exit $status',
    tmp,
    path
  );
}

/**
 * Copy or move `src` into folder `destDir`.
 * If the name is taken, picks "name copy.ext", "name copy 2.ext", … like a desktop file manager.
 * Prints the final destination path on stdout.
 */
const PASTE_SCRIPT = `
src="$1"; dir="$2"; name="$3"; mode="$4"
case "$dir" in */) ;; *) dir="$dir/" ;; esac
dest="$dir$name"
if [ -e "$dest" ] || [ -L "$dest" ]; then
  base="$name"; ext=""
  if [ ! -d "$src" ]; then
    case "$name" in ?*.*) base="\${name%.*}"; ext=".\${name##*.}" ;; esac
  fi
  dest="$dir$base copy$ext"; i=2
  while [ -e "$dest" ] || [ -L "$dest" ]; do dest="$dir$base copy $i$ext"; i=$((i+1)); done
fi
if [ "$mode" = move ]; then mv -- "$src" "$dest"; else cp -R -- "$src" "$dest"; fi || exit 1
printf %s "$dest"
`;

export function pasteEntry(
  pod: Pod,
  container: string,
  src: string,
  destDir: string,
  mode: 'copy' | 'move'
): Promise<ExecResult> {
  const name = src.slice(src.lastIndexOf('/') + 1);
  return sh(pod, container, PASTE_SCRIPT, src, destDir, name, mode);
}
