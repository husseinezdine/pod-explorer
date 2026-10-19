# Pod Explorer — Headlamp plugin

Adds a **Files** section to every Pod page in Headlamp: browse folders, follow symlinks, preview and edit text files, create files and folders, and copy/cut/paste inside the container.

## Run it (dev mode)

```bash
npm install
npm run start
```

Then in Headlamp Desktop: **Settings → Plugins → enable "Plugin Development Mode"**, and reload.
Open any running Pod — the **Files** section is at the bottom of the page.

## How it works

- Uses Headlamp's built-in `pod.exec`, so cluster auth and RBAC come from Headlamp.
- Lists folders with `ls -lA` and previews files with `head -c` (first 256 KB).
- Writes files by sending base64 chunks through `sh` + `base64 -d` to a temp file, then `cat >` over the target, so the file keeps its owner, permissions and symlinks.
- Copy/cut/paste uses `cp -R` / `mv`; name clashes become "name copy.ext", "name copy 2.ext", like a desktop file manager.
- Creates files with `: >` and folders with `mkdir`; names are passed as shell arguments, never pasted into the script.
- Works with GNU coreutils (Debian/Ubuntu images) and BusyBox (Alpine).

## Known limits (next steps)

- Distroless / scratch images have no `ls`, so listing fails with a clear message.
  Fix: ephemeral debug container + `/proc/<pid>/root`.
- No download / upload / delete / rename yet.
- Paste works within the same container (not across containers or pods).
- Files larger than 256 KB open read-only.
- No runtime detection (Node, Python, Java…) yet.

## Files

- `src/index.tsx` — registers the section on Pod pages
- `src/FilesSection.tsx` — the UI
- `src/execCommand.ts` — runs a one-shot command and collects stdout/stderr
- `src/fileOps.ts` — create file, create folder, write file, copy/move
- `src/parseLs.ts` — parses `ls -lA` output
