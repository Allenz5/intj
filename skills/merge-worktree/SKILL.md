---
name: merge-worktree
description: Merge one or more intj worktree branches into the current branch and commit the result. Worktrees and branches are kept. Use when the user says "/intj:merge-worktree", asks to merge worktrees or sessions, or wants to fold finished sessions back in.
---

# Merge worktree

In intj, one AI session is one git worktree on a branch `intj/<id>` under `.intj/worktrees/<id>`. This skill merges any number of them into the branch checked out where the skill runs. It never deletes a worktree or branch: the session keeps going after a merge, and only ending the session removes them.

## Steps

1. **Pick the worktrees.** Use the ids or branches the user names. If they name none, run `git worktree list`, show the `intj/*` worktrees with their last commit (`git log -1 --oneline intj/<id>`), and ask which to merge. Never merge the worktree you are running in into itself.

2. **Check that nothing will be lost.**
   - The target (current checkout) must have a clean `git status`. If not, stop and ask.
   - For each source worktree, run `git -C <path> status --porcelain`. If it has uncommitted changes, commit them there first: `git -C <path> add -A && git -C <path> commit -m "intj <id>: <short summary>"`.

3. **Merge each branch in turn.**

   ```sh
   git merge --no-ff intj/<id> -m "Merge intj/<id>"
   ```

   On a conflict, read both sides. Resolve it when the intent of both is clear, then `git add` and `git commit --no-edit`. When the intent is unclear, run `git merge --abort`, stop, and show the user the conflicting files.

4. **Commit.** Every merge must end in a commit. Check `git status`: if a merge left anything staged or unresolved, finish it and commit before moving on. Confirm with `git merge-base --is-ancestor intj/<id> HEAD`.

5. **Report.** List what merged, what was skipped and why, and any conflicts you resolved with a one-line note on each. Do not push unless the user asks.
