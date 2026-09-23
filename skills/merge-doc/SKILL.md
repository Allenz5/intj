---
name: merge-doc
description: Resolve the conflict markers opendoc left in a session's markdown docs when merging them back into the workload. Takes the conflicted doc paths as its argument. Use when the user says "/opendoc:merge-doc", or when a doc merge left `<<<<<<< current` / `>>>>>>> session` markers to resolve.
---

# Merge doc

In opendoc the docs live outside git. Each session edits its own copy of the workload's docs in its worktree. On Merge, opendoc merges the workload's current docs into the session's copy first. Where both sides changed the same lines, the session's copy gets conflict markers:

```
<<<<<<< current
what the workload has now (other sessions' merged work)
=======
what this session wrote
>>>>>>> session
```

This skill resolves those markers in the session's copy. The next Merge copies the resolved doc into the workload, so never edit the workload's doc.

## Steps

1. **Read each doc passed as an argument.** Every conflict block has two sides: `current` is the workload's version, `session` is this session's version. Read the text around each block too, so you know what the section is about.

2. **Resolve each block by keeping the intent of both sides.**
   - When both sides added different content, keep both, in an order that reads well.
   - When both sides rewrote the same statement, write one statement that holds both changes.
   - When the sides contradict each other and you can't tell which is right, keep both, joined by a line that begins `待确认：`, and report it.
   - Keep the doc's language, structure and style. Remove every marker line.

3. **Check.** Search each doc for leftover `<<<<<<<`, `=======` and `>>>>>>>` lines, and delete any you find.

4. **Continue with anything the argument asks for afterward**, such as resolving git conflicts in the same worktree.

5. **Report.** For each doc, give one line per conflict saying how you resolved it, and list any `待确认` items.
