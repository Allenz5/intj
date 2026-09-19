---
name: open-worktree
description: Open a new git worktree for a new AI session, under .intj/worktrees/<id> on branch intj/<id>. Use when the user says "/intj:open-worktree", asks to open or create a worktree, or wants to start a new session from a markdown doc.
---

# Open worktree

In intj, one AI session is one git worktree. This skill creates the worktree; the user then starts a session in it with whatever harness they use.

## Steps

1. **Locate the main checkout.** Run `git rev-parse --path-format=absolute --git-common-dir` and take its parent directory as `<root>`. All worktrees live under `<root>/.intj/worktrees/`, even when this skill runs inside another worktree.

2. **Keep worktrees out of git.** Workload docs under `.intj/<workload>/` are tracked, so exclude only worktrees: make sure `<root>/.git/info/exclude` contains the lines `.intj/worktrees/` and `.intj/*/worktrees/`, and no line `.intj/`. Do not edit `.gitignore`.

3. **Pick the base.** Default to the current `HEAD`. Use a different branch or commit if the user names one.

4. **Pick an id.** Generate 6 random hex characters (`openssl rand -hex 3`). Regenerate if `<root>/.intj/worktrees/<id>` or branch `intj/<id>` already exists.

5. **Create the worktree.**

   ```sh
   git worktree add -b intj/<id> <root>/.intj/worktrees/<id> <base>
   ```

6. **Record the source doc.** If the session is opened from a markdown doc (the user names one, or you are working in one), mention its path in the report so the new session knows which doc it works under.

7. **Report.** Give the worktree path, the branch name, the base, and the source doc if any. Tell the user to start their agent in that directory, e.g. `cd <path> && claude` or `cd <path> && codex`.
