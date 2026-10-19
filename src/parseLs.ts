export interface FileEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  permissions: string;
  owner: string;
  group: string;
  size: number;
  modified: string;
  /** Symlink target, if this entry is a link. */
  target?: string;
}

// Matches one line of `ls -lA` from both GNU coreutils and BusyBox, e.g.
//   drwxr-xr-x    2 root     root          4096 Oct 15 09:12 bin
//   -rw-r--r--    1 node     node           512 Jan  3  2025 package.json
//   lrwxrwxrwx    1 root     root             7 Oct 15 09:12 lib64 -> usr/lib
// Device files ("crw-rw-rw- 1 root root 1, 3 ...") have "major, minor" instead of a size.
const LS_LINE =
  /^([\-dlcbps][rwxsStT\-]{9}[.+@]?)\s+\d+\s+(\S+)\s+(\S+)\s+(\d+|\d+,\s*\d+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s(.+)$/;

export function parseLs(output: string): FileEntry[] {
  const entries: FileEntry[] = [];

  for (const line of output.split('\n')) {
    const match = LS_LINE.exec(line.trimEnd());
    if (!match) continue; // skips "total N" and anything unexpected

    const [, permissions, owner, group, size, modified, rawName] = match;
    const kind = permissions[0];
    let name = rawName;
    let target: string | undefined;

    if (kind === 'l') {
      const arrow = rawName.indexOf(' -> ');
      if (arrow !== -1) {
        name = rawName.slice(0, arrow);
        target = rawName.slice(arrow + 4);
      }
    }

    entries.push({
      name,
      type: kind === 'd' ? 'dir' : kind === 'l' ? 'link' : kind === '-' ? 'file' : 'other',
      permissions,
      owner,
      group,
      size: size.includes(',') ? 0 : Number(size),
      modified: modified.replace(/\s+/g, ' '),
      target,
    });
  }

  // Folders first, then alphabetical.
  return entries.sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

export function parentPath(path: string): string {
  if (path === '/') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}
