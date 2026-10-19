# Publishing Pod Explorer

Headlamp's Plugin Catalog lists plugins from **Artifact Hub**. Artifact Hub reads
`artifacthub-pkg.yml` from your GitHub repo, and Headlamp downloads the plugin
tarball from your GitHub release.

## 1. Replace the placeholder

Replace `GITHUB_USERNAME` with your GitHub username in:

- `artifacthub-pkg.yml` (3 places)
- `package.json` (`repository.url`)

## 2. Create the GitHub repo and push

Create an empty **public** repo named `pod-explorer` on github.com, then:

```bash
git init
git add .
git commit -m "Pod Explorer v0.3.0"
git branch -M main
git remote add origin https://github.com/GITHUB_USERNAME/pod-explorer.git
git push -u origin main
```

## 3. Create the release

On GitHub: **Releases → Draft a new release**

- Tag: `v0.3.0`
- Title: `v0.3.0`
- Attach the file **`pod-explorer-0.3.0.tar.gz`** exactly as provided
  (its SHA256 is already in `artifacthub-pkg.yml`)
- Publish

Check the download link works:
`https://github.com/GITHUB_USERNAME/pod-explorer/releases/download/v0.3.0/pod-explorer-0.3.0.tar.gz`

## 4. Register on Artifact Hub

1. Sign in at https://artifacthub.io
2. Control Panel → **Add** repository
3. Kind: **Headlamp plugins**
4. Name: `pod-explorer`, URL: `https://github.com/GITHUB_USERNAME/pod-explorer`
5. Add. Artifact Hub scans the repo (can take up to ~30 minutes).

Optional: copy the **repository ID** Artifact Hub shows and add it to
`artifacthub-repo.yml` as `repositoryID: <id>` to claim ownership ("Verified publisher").

## 5. Find it in Headlamp

Headlamp → **Plugin Catalog**. By default the catalog shows only official /
allow-listed plugins, so turn off **"Only official plugins"** to see Pod Explorer.

## Releasing a new version

1. Bump `version` in `package.json`
2. `npm install && npm run build && npm run package` — note the printed SHA256
3. New GitHub release `vX.Y.Z` with the new tarball attached
4. In `artifacthub-pkg.yml` update `version`, `createdAt`, `archive-url`,
   `archive-checksum` (keep the `SHA256:` prefix) and `changes`
5. Commit and push — Artifact Hub picks it up on its next scan

The checksum must match the uploaded tarball exactly. If you rebuild or
repackage, use the new checksum.
