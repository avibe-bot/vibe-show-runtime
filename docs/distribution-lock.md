# Locked production archives

## Contract

`npm run bundle:vibe-remote` stages the three built first-party packages and the
committed `distribution/package.json` and `distribution/package-lock.json`, then
runs `npm ci --ignore-scripts --omit=dev --include=optional --install-links=false`.
It never resolves or updates a lock. Missing, stale, or inconsistent inputs fail
closed. `--no-audit --no-fund` avoids unrelated requests during installation.

Local `file:./packages/{runtime,ui,sdk}` links remain inside the archive. Their
source manifests and built `dist` outputs come from the reviewed source commit;
these local directories do not have npm tarball integrity. The builder verifies
that their dependency metadata still matches the committed lock. Registry
packages have fixed HTTPS URLs and SHA-512 integrity. Their versions, URLs and
integrity must also match the source lock at the same dependency path, so a
source-lock security update cannot silently leave an older distribution artifact.
Bundled children, where
present, are covered by their enclosing integrity-pinned registry tarball.

Optional platform packages are retained, so esbuild, Tailwind oxide and
Lightning CSS work without install scripts. Dependency lifecycle scripts remain
disabled, including when a dependency adds a new script. Explicit first-party
`npm run build` commands still run: these are reviewed build steps, not implicit
third-party lifecycle hooks. No postinstall allowlist or weaker retry exists.

## Maintaining the distribution lock

After changing package requirements or updating the source dependency lock:

```bash
npm ci --ignore-scripts --include=optional
npm run lock:bundle
# Review both distribution files and any dependency/version changes.
npm run check
npm run bundle:vibe-remote
npm run smoke:bundle
```

`lock:bundle` is a maintenance-only resolver. It stages package manifests without
build outputs or `node_modules`, seeds from the reviewed source lock, removes
example-workspace records, and runs `npm install --package-lock-only` with
scripts off and optional dependencies included. It normalizes that graph for the
production consumer, keeping existing source-lock versions instead of selecting
new versions merely because a release was built later. It writes the resulting
manifest and lock to `distribution/`; commit both in the dependency-change PR.
The bundle command and CI never call this resolver automatically.

The initial distribution lock preserves every shared third-party version from
the source lock. Generation from a clean stage retains optional packages for all
six supported OS/architecture pairs instead of encoding only the author's host.

## Acceptance evidence

The script tests own the dependency contract: stale root inputs or local-package
requirements fail before installation, unpinned external sources are rejected,
only package manifests and built output are staged, and native packages for all
six supported platform pairs stay in the lock. Existing tests did not cover
this boundary: the old bundler resolved transitives afresh on every invocation.

CI builds with lifecycle scripts off on Linux, macOS and Windows. After bundling,
`smoke:bundle` extracts the real archive outside the checkout, checks that its
manifest/lock bytes equal the committed inputs, and resolves esbuild, Lightning
CSS, Tailwind oxide and Vite from that extracted install. It exercises native
TypeScript/CSS transforms, boots the extracted Runtime, loads a shadcn page, and
checks generated Tailwind utility CSS. This is a bounded one-page runtime smoke,
not a browser or stress suite.

Known limits: a lock establishes artifact identity, not code trust. Build output
is source-commit-specific and archive bytes need not be byte-for-byte identical
across toolchains or platforms. The separate Avibe manifest still owns archive
hash verification and adoption; this PR does not publish, release, or deploy it.
