# opendoc

A local web tool for driving coding agents from your markdown docs. Open a doc, select a
passage, say what you want done, and opendoc spins up a coding agent (Claude Code by default) in
its own git worktree with that context. Review each session's edits and merge them back — code
through git, docs through a 3-way merge — from the same page.

## Start

```bash
npm install
npm run dev            # opens http://localhost:5173
```

Options (all optional):

```bash
npm run dev -- /path/to/start   # where the folder picker starts (default: cwd)
PORT=6000 npm run dev           # serve on a different port
```

## Use

1. **Pick a project folder** — any git repo (a non-repo is `git init`ed for you). On this start
   page you also set, and can edit before opening:
   - **Agent command** — the shell command that launches the agent (default `claude`; any CLI
     agent works).
   - **Sparse directories** — space-separated paths to cone-checkout in each session's worktree,
     to keep worktree creation fast on a huge repo. Leave empty for a full checkout.

   Both are saved per project under `.opendoc/settings.json` and reloaded into the inputs when you
   browse back to that folder.

2. **Pick or create a workload** — a workload is a set of markdown docs kept under
   `.opendoc/<timestamp>-<uuid>/`, starting from `main.md`. Docs live outside git and are never
   committed.

3. **Work from the doc** — select text (or right-click a block) and:
   - **Start chat** — open an agent session on that selection in a fresh worktree.
   - **Fork chat** — continue from another session's files and conversation.
   - **Split doc** — move a section's detail into a linked child doc.

4. **Manage sessions** — each session shows as a card by its quote. **Open terminal** to watch
   or steer its agent, **Merge** to fold its code and doc edits back (conflicts are handed to the
   session's own agent to resolve), **End** to drop its worktree and branch.

## Layout

- `server/index.ts` — HTTP + WebSocket server: the folder/workload picker, agent terminals
  (via `node-pty`), git worktree sessions, and doc merging.
- `web/` — the browser UI (`main.ts`, `index.html`, `style.css`), served by Vite.
- `skills/` — the agent skills opendoc invokes (`update-docs`, `split-doc`, `merge-doc`, …).
- `.opendoc/` — per-project workloads, docs, session worktrees, and `settings.json`. Kept out of git.
