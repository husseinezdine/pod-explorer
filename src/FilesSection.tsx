import { Icon } from '@iconify/react';
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';
import { execCommand } from './execCommand';
import { createFile, createFolder, pasteEntry, writeFile } from './fileOps';
import { FileEntry, formatSize, joinPath, parentPath, parseLs } from './parseLs';

type Pod = InstanceType<typeof K8s.ResourceClasses.Pod>;

/** Largest file preview we pull out of the container. Larger files open read-only. */
const MAX_PREVIEW_BYTES = 256 * 1024;

const ICONS: Record<FileEntry['type'], string> = {
  dir: 'mdi:folder',
  file: 'mdi:file-outline',
  link: 'mdi:link-variant',
  other: 'mdi:file-question-outline',
};

function explainError(error: string | undefined, stderr: string): string {
  const text = `${stderr} ${error ?? ''}`.trim();
  if (/executable file not found|not found in \$PATH/i.test(text)) {
    return 'This container is missing basic tools like "ls" or "sh" (probably a distroless or scratch image). Debug-container support is the next step for these images.';
  }
  if (/read-only file system/i.test(text)) {
    return 'This location is on a read-only file system, so it cannot be changed.';
  }
  if (/permission denied/i.test(text)) {
    return 'Permission denied: the container user cannot write here.';
  }
  if (/forbidden/i.test(text)) {
    return 'Your Kubernetes user is not allowed to exec into this pod (needs the pods/exec permission).';
  }
  // Prefer our own stderr message over the generic "non-zero exit code" status.
  return stderr.trim() || error || 'Unknown error.';
}

interface Preview {
  path: string;
  content?: string;
  error?: string;
  binary?: boolean;
  truncated?: boolean;
  loading?: boolean;
}

type CreateKind = 'file' | 'folder';

interface Clipboard {
  path: string;
  name: string;
  isDir: boolean;
  mode: 'copy' | 'move';
  container: string;
}

export function FilesSection({ pod }: { pod: Pod }) {
  const containers = (pod.spec?.containers ?? []).map(c => c.name);
  const [container, setContainer] = React.useState(containers[0] ?? '');
  const [path, setPath] = React.useState('/');
  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // File viewer / editor
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // "New file" / "New folder" dialog
  const [creating, setCreating] = React.useState<CreateKind | null>(null);
  const [newName, setNewName] = React.useState('');
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [createBusy, setCreateBusy] = React.useState(false);
  const nameInputRef = React.useRef<HTMLInputElement>(null);

  // Copy / cut / paste
  const [clipboard, setClipboard] = React.useState<Clipboard | null>(null);
  const [rowMenu, setRowMenu] = React.useState<{ anchor: HTMLElement; entry: FileEntry } | null>(
    null
  );
  const [pasteBusy, setPasteBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  const isRunning = pod.status?.phase === 'Running';

  const loadDir = React.useCallback(
    async (dir: string) => {
      if (!container) return;
      setLoading(true);
      setError(null);
      // Trailing slash makes ls follow a symlinked directory instead of listing the link itself.
      const target = dir === '/' ? '/' : `${dir}/`;
      const result = await execCommand(pod, container, ['ls', '-lA', '--', target]);
      setLoading(false);

      if (!result.ok && !result.stdout) {
        setError(explainError(result.error, result.stderr));
        return;
      }
      setPath(dir);
      setEntries(parseLs(result.stdout));
    },
    [pod, container]
  );

  React.useEffect(() => {
    if (isRunning) loadDir('/');
    // Reload from root whenever the selected container changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, isRunning]);

  function closePreview() {
    if (saving) return;
    setPreview(null);
    setEditing(false);
    setSaveError(null);
  }

  async function openFile(filePath: string, startEditing = false) {
    setEditing(false);
    setSaveError(null);
    setPreview({ path: filePath, loading: true });
    const result = await execCommand(pod, container, [
      'head',
      '-c',
      String(MAX_PREVIEW_BYTES + 1),
      '--',
      filePath,
    ]);
    if (!result.ok && !result.stdout) {
      setPreview({ path: filePath, error: explainError(result.error, result.stderr) });
      return;
    }
    const binary = result.stdout.includes('\u0000');
    const truncated = result.stdout.length > MAX_PREVIEW_BYTES;
    const content = binary ? undefined : result.stdout.slice(0, MAX_PREVIEW_BYTES);
    setPreview({ path: filePath, content, binary, truncated });
    if (startEditing && content !== undefined && !truncated) {
      setDraft(content);
      setEditing(true);
    }
  }

  function startEditing() {
    if (preview?.content === undefined) return;
    setDraft(preview.content);
    setSaveError(null);
    setEditing(true);
  }

  async function save() {
    if (!preview) return;
    setSaving(true);
    setSaveError(null);
    const result = await writeFile(pod, container, preview.path, draft);
    setSaving(false);
    if (!result.ok) {
      setSaveError(explainError(result.error, result.stderr));
      return;
    }
    setPreview({ ...preview, content: draft });
    setEditing(false);
    loadDir(path); // refresh sizes and dates
  }

  function openCreateDialog(kind: CreateKind) {
    setCreating(kind);
    setNewName('');
    setCreateError(null);
  }

  async function submitCreate() {
    const name = newName.trim();
    if (!creating) return;
    if (!name || name === '.' || name === '..' || name.includes('/')) {
      setCreateError('Enter a name without "/".');
      return;
    }
    const fullPath = joinPath(path, name);
    setCreateBusy(true);
    setCreateError(null);
    const result =
      creating === 'file'
        ? await createFile(pod, container, fullPath)
        : await createFolder(pod, container, fullPath);
    setCreateBusy(false);
    if (!result.ok) {
      setCreateError(explainError(result.error, result.stderr));
      return;
    }
    const kind = creating;
    setCreating(null);
    await loadDir(path);
    if (kind === 'file') openFile(fullPath, true);
  }

  function putOnClipboard(entry: FileEntry, mode: Clipboard['mode']) {
    setRowMenu(null);
    setNotice(null);
    setClipboard({
      path: joinPath(path, entry.name),
      name: entry.name,
      isDir: entry.type === 'dir',
      mode,
      container,
    });
  }

  /** Why paste is not possible here, or null if it is. */
  function pasteBlockedReason(): string | null {
    if (!clipboard) return 'Nothing copied.';
    if (clipboard.container !== container) {
      return `Copied from container "${clipboard.container}". Switch back to paste.`;
    }
    const here = path === '/' ? '/' : `${path}/`;
    if (
      clipboard.isDir &&
      (here === `${clipboard.path}/` || here.startsWith(`${clipboard.path}/`))
    ) {
      return 'Cannot paste a folder inside itself.';
    }
    if (clipboard.mode === 'move' && parentPath(clipboard.path) === path) {
      return 'Already in this folder.';
    }
    return null;
  }

  async function paste() {
    if (!clipboard || pasteBlockedReason()) return;
    setPasteBusy(true);
    setNotice(null);
    const result = await pasteEntry(pod, container, clipboard.path, path, clipboard.mode);
    setPasteBusy(false);
    if (!result.ok) {
      setNotice({ ok: false, text: explainError(result.error, result.stderr) });
      return;
    }
    const finalName = result.stdout.slice(result.stdout.lastIndexOf('/') + 1);
    setNotice({
      ok: true,
      text: `${clipboard.mode === 'move' ? 'Moved' : 'Pasted'} "${clipboard.name}"${
        finalName && finalName !== clipboard.name ? ` as "${finalName}"` : ''
      }.`,
    });
    // A cut item can only be pasted once; a copied item can be pasted again.
    if (clipboard.mode === 'move') setClipboard(null);
    loadDir(path);
  }

  async function onEntryClick(entry: FileEntry) {
    const fullPath = joinPath(path, entry.name);
    if (entry.type === 'dir') {
      loadDir(fullPath);
    } else if (entry.type === 'link') {
      // A link may point to a folder or a file: try it as a folder first.
      const result = await execCommand(pod, container, ['ls', '-lA', '--', `${fullPath}/`]);
      if (result.ok) {
        setPath(fullPath);
        setEntries(parseLs(result.stdout));
      } else {
        openFile(fullPath);
      }
    } else if (entry.type === 'file') {
      openFile(fullPath);
    }
  }

  const crumbs = path === '/' ? [] : path.split('/').filter(Boolean);
  const canEdit = !!preview && preview.content !== undefined && !preview.truncated;

  return (
    <SectionBox title="Files">
      {!isRunning ? (
        <Alert severity="info">The pod must be running to browse its files.</Alert>
      ) : (
        <>
          <Box display="flex" alignItems="center" gap={2} mb={1} flexWrap="wrap">
            {containers.length > 1 && (
              <Select
                size="small"
                value={container}
                onChange={e => setContainer(String(e.target.value))}
                aria-label="Container"
              >
                {containers.map(name => (
                  <MenuItem key={name} value={name}>
                    {name}
                  </MenuItem>
                ))}
              </Select>
            )}
            <IconButton
              size="small"
              aria-label="Up one folder"
              disabled={path === '/' || loading}
              onClick={() => loadDir(parentPath(path))}
            >
              <Icon icon="mdi:arrow-up" />
            </IconButton>
            <Breadcrumbs sx={{ flex: 1, minWidth: 0 }}>
              <Link component="button" onClick={() => loadDir('/')}>
                /
              </Link>
              {crumbs.map((part, i) => {
                const crumbPath = '/' + crumbs.slice(0, i + 1).join('/');
                return (
                  <Link key={crumbPath} component="button" onClick={() => loadDir(crumbPath)}>
                    {part}
                  </Link>
                );
              })}
            </Breadcrumbs>
            <Button
              size="small"
              startIcon={<Icon icon="mdi:file-plus-outline" />}
              disabled={loading || !!error}
              onClick={() => openCreateDialog('file')}
            >
              New file
            </Button>
            <Button
              size="small"
              startIcon={<Icon icon="mdi:folder-plus-outline" />}
              disabled={loading || !!error}
              onClick={() => openCreateDialog('folder')}
            >
              New folder
            </Button>
            {clipboard && (
              <>
                <Chip
                  size="small"
                  icon={
                    <Icon
                      icon={clipboard.mode === 'move' ? 'mdi:content-cut' : 'mdi:content-copy'}
                    />
                  }
                  label={`${clipboard.mode === 'move' ? 'Cut' : 'Copied'}: ${clipboard.name}`}
                  onDelete={() => setClipboard(null)}
                  sx={{ maxWidth: 240 }}
                />
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={
                    pasteBusy ? <CircularProgress size={14} /> : <Icon icon="mdi:content-paste" />
                  }
                  disabled={loading || pasteBusy || !!error || !!pasteBlockedReason()}
                  title={pasteBlockedReason() ?? `Paste into ${path}`}
                  onClick={paste}
                >
                  Paste here
                </Button>
              </>
            )}
            <IconButton
              size="small"
              aria-label="Refresh"
              disabled={loading}
              onClick={() => loadDir(path)}
            >
              <Icon icon="mdi:refresh" />
            </IconButton>
          </Box>

          {error && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              {error}
            </Alert>
          )}
          {notice && (
            <Alert
              severity={notice.ok ? 'success' : 'error'}
              sx={{ mb: 1 }}
              onClose={() => setNotice(null)}
            >
              {notice.text}
            </Alert>
          )}
          {clipboard && pasteBlockedReason() && !pasteBusy && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
              {pasteBlockedReason()}
            </Typography>
          )}

          {loading ? (
            <Box display="flex" justifyContent="center" p={3}>
              <CircularProgress size={28} />
            </Box>
          ) : (
            <Box sx={{ maxHeight: 480, overflow: 'auto' }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell align="right">Size</TableCell>
                    <TableCell>Modified</TableCell>
                    <TableCell>Owner</TableCell>
                    <TableCell>Permissions</TableCell>
                    <TableCell padding="checkbox" aria-label="Actions" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {entries.length === 0 && !error && (
                    <TableRow>
                      <TableCell colSpan={6}>
                        <Typography variant="body2" color="text.secondary">
                          Empty folder
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                  {entries.map(entry => (
                    <TableRow
                      key={entry.name}
                      hover
                      sx={{
                        cursor: entry.type === 'other' ? 'default' : 'pointer',
                        opacity:
                          clipboard?.mode === 'move' &&
                          clipboard.container === container &&
                          clipboard.path === joinPath(path, entry.name)
                            ? 0.5
                            : 1,
                      }}
                      onClick={() => onEntryClick(entry)}
                    >
                      <TableCell>
                        <Box display="flex" alignItems="center" gap={1}>
                          <Icon icon={ICONS[entry.type]} width={18} />
                          <span>{entry.name}</span>
                          {entry.target && (
                            <Typography variant="caption" color="text.secondary">
                              → {entry.target}
                            </Typography>
                          )}
                        </Box>
                      </TableCell>
                      <TableCell align="right">
                        {entry.type === 'dir' ? '—' : formatSize(entry.size)}
                      </TableCell>
                      <TableCell>{entry.modified}</TableCell>
                      <TableCell>
                        {entry.owner}:{entry.group}
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{entry.permissions}</TableCell>
                      <TableCell padding="checkbox">
                        {entry.type !== 'other' && (
                          <IconButton
                            size="small"
                            aria-label={`Actions for ${entry.name}`}
                            onClick={e => {
                              e.stopPropagation();
                              setRowMenu({ anchor: e.currentTarget, entry });
                            }}
                          >
                            <Icon icon="mdi:dots-vertical" />
                          </IconButton>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </>
      )}

      <Menu anchorEl={rowMenu?.anchor} open={!!rowMenu} onClose={() => setRowMenu(null)}>
        <MenuItem onClick={() => rowMenu && putOnClipboard(rowMenu.entry, 'copy')}>
          <ListItemIcon>
            <Icon icon="mdi:content-copy" />
          </ListItemIcon>
          <ListItemText>Copy</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => rowMenu && putOnClipboard(rowMenu.entry, 'move')}>
          <ListItemIcon>
            <Icon icon="mdi:content-cut" />
          </ListItemIcon>
          <ListItemText>Cut</ListItemText>
        </MenuItem>
      </Menu>

      {/* File viewer / editor */}
      <Dialog open={!!preview} onClose={closePreview} maxWidth="lg" fullWidth>
        <DialogTitle sx={{ fontFamily: 'monospace', fontSize: '1rem' }}>
          {preview?.path}
          {editing && (
            <Typography component="span" variant="caption" color="warning.main" sx={{ ml: 1 }}>
              editing
            </Typography>
          )}
        </DialogTitle>
        <DialogContent dividers>
          {preview?.loading && (
            <Box display="flex" justifyContent="center" p={3}>
              <CircularProgress size={28} />
            </Box>
          )}
          {preview?.error && <Alert severity="warning">{preview.error}</Alert>}
          {preview?.binary && <Alert severity="info">Binary file — preview not shown.</Alert>}
          {preview?.truncated && (
            <Alert severity="info" sx={{ mb: 1 }}>
              Showing the first {formatSize(MAX_PREVIEW_BYTES)} only. Files this large open
              read-only.
            </Alert>
          )}
          {saveError && (
            <Alert severity="error" sx={{ mb: 1 }}>
              {saveError}
            </Alert>
          )}
          {editing ? (
            <TextField
              value={draft}
              onChange={e => setDraft(e.target.value)}
              multiline
              fullWidth
              minRows={16}
              maxRows={32}
              disabled={saving}
              inputProps={{
                spellCheck: false,
                'aria-label': 'File content',
                style: { fontFamily: 'monospace', fontSize: 13 },
              }}
            />
          ) : (
            preview?.content !== undefined && (
              <Box
                component="pre"
                sx={{ m: 0, fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
              >
                {preview.content || '(empty file)'}
              </Box>
            )
          )}
        </DialogContent>
        <DialogActions>
          {editing ? (
            <>
              <Button onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant="contained"
                onClick={save}
                disabled={saving || draft === preview?.content}
                startIcon={
                  saving ? <CircularProgress size={16} /> : <Icon icon="mdi:content-save" />
                }
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : (
            <>
              {canEdit && (
                <Button onClick={startEditing} startIcon={<Icon icon="mdi:pencil" />}>
                  Edit
                </Button>
              )}
              <Button onClick={closePreview}>Close</Button>
            </>
          )}
        </DialogActions>
      </Dialog>

      {/* New file / New folder */}
      <Dialog
        open={!!creating}
        onClose={() => !createBusy && setCreating(null)}
        maxWidth="xs"
        fullWidth
        TransitionProps={{ onEntered: () => nameInputRef.current?.focus() }}
      >
        <DialogTitle>{creating === 'folder' ? 'New folder' : 'New file'}</DialogTitle>
        <DialogContent>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mb: 1, fontFamily: 'monospace' }}
          >
            in {path}
          </Typography>
          <TextField
            inputRef={nameInputRef}
            fullWidth
            size="small"
            label="Name"
            value={newName}
            disabled={createBusy}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submitCreate();
            }}
          />
          {createError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {createError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreating(null)} disabled={createBusy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={submitCreate}
            disabled={createBusy || !newName.trim()}
          >
            {createBusy ? 'Creating…' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>
    </SectionBox>
  );
}
