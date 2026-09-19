---
name: update-docs
description: Update the project's markdown docs so they describe the current state of the work. Use when the user says "/intj:update-docs", asks to update the docs, or when a piece of work is finished and the docs that govern it are now out of date.
---

# Update docs

In an intj project the markdown docs are the interface between the user and the agent. They form a tree under the workload folder `.intj/<date-time>-<uuid>/`: `main.md` at the root, with child docs for submodules. Each doc describes what its part of the project is and does. This skill brings the docs back in line with the work.

## Steps

1. **Find what changed.** Read the diff of the current work: `git diff` plus `git diff <base>...HEAD` for commits on this branch, where `<base>` is the branch this one started from (usually `main`). If the user described the change, use their description too.

2. **Find the docs that govern it.** Start from the doc this session was opened from, if the user named one. Otherwise walk the doc tree from `main.md` down and pick the docs whose scope covers the changed code. A change can touch several docs; a doc's parent needs editing only if the change alters what the parent says about it.

3. **Edit those docs to describe the current state.**
   - Write what the project is and does now. Replace outdated statements in place.
   - Keep each doc's language, structure, heading style and level of detail. A Chinese doc stays Chinese.
   - Leave out changelogs, dates, "updated to…" notes and descriptions of how the work was done.
   - Touch only the sections the change affects.

4. **Add a child doc only when a new submodule has no doc to live in.** Link it from its parent doc.

5. **Show the result.** Report which docs changed and summarize each edit in one line. Do not commit unless the user asks.
