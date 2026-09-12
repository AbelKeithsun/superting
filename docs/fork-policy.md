# SuperTing Fork Policy

SuperTing is an independent fork based on the MIT-licensed OpenWhispr project.
The fork keeps upstream attribution, but does not treat `OpenWhispr/openwhispr`
as an upstream branch for routine merges or rebases.

The repository lives at `sysusugan/superting`. It started as an MIT-licensed
fork of `OpenWhispr/openwhispr`; after the rebrand it remains a fork of that
upstream but is published under its own GitHub identity.

## Maintenance Rules

- Keep product identity, app identifiers, protocols, local data paths, MCP
  metadata, and release downloads under SuperTing names.
- Do not add a permanent `upstream` remote for `OpenWhispr/openwhispr`.
- Use upstream code only through explicit cherry-picks or manually reviewed
  patches.
- Keep OpenWhispr attribution and MIT license notices intact.
- Prefer local-first and BYOK behavior unless a SuperTing-owned hosted service is
  explicitly introduced.

## Remote and Branch Topology

Two remotes are configured locally; each has exactly one job:

```
OpenWhispr/openwhispr            upstream project (MIT, attribution only, no remote)
        │ fork
        ▼
sysusugan/superting              remote: origin — the source repository
        │ fork
        ▼
AbelKeithsun/superting           remote: abel — the development fork
```

- **`abel` is where work happens.** The development line of record is
  `abel/main`: feature branches (`codex/<topic>`) target it via rebase-merged
  PRs and are deleted from the remote immediately after merge.
- **Local `main` tracks `abel/main`.** `origin/main` is currently a lagging
  mirror; pushing it back (`git push origin main`) is an explicit manual sync
  action, never an automatic one.
- **Releases are cut from `abel/main`**: a `chore: release vX.Y.Z` commit on
  `main`, a `vX.Y.Z` tag, and a GitHub Release with three assets (dmg, zip,
  `superting-skills-<ver>.tgz`).
- OpenWhispr stays attribution-only: no `upstream` remote, no routine merges
  from it (see Maintenance Rules above).
