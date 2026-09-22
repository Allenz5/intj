---
name: split-doc
description: Split one module out of a markdown doc - keep a short version in place and move the full detail into a new child doc linked from it. Takes optional extra conditions as its argument. Use when the user says "/opendoc:split-doc", or asks to shorten a section of a doc by moving its detail into a sub-doc.
---

# Split doc

In an opendoc project the markdown docs form a tree under the workload folder `.opendoc/<date-time>-<uuid>/`: `main.md` at the root, with child docs for submodules. This skill takes one module that has grown too detailed for its doc, keeps a concise version of it in place, and moves the full content into a child doc linked from there.

## Input

- **The module.** The message quotes it as lines starting with `>`, usually text selected in the doc. If nothing is quoted, use the section the user names; if there is none, ask.
- **Extra conditions** (optional): any other text in the argument, e.g. what the short version must keep, the child doc's name, or where it goes. They override the defaults below.

## Steps

1. **Find the module.** Look for the quoted text in the workload folders' markdown docs (`.opendoc/*/`, a hidden folder, so include hidden files when searching; skip `worktrees/`), starting with each `main.md`. The module is the whole block the quote belongs to - its heading and everything under it, or the list item with its sub-items - even when the quote covers only part of it.

2. **Write the child doc.**
   - Put it next to the parent doc, named after the module in kebab-case (e.g. `comment-panel.md`), unless the conditions say otherwise or the project already keeps child docs elsewhere. Do not overwrite an existing file.
   - Start it with a `# ` heading naming the module, then all of the module's content. Keep its language, wording and structure; adjust only heading levels and relative links so they still work from the new location.

3. **Shorten the module in the parent doc.** Replace it in place with a concise version: same heading or list item, one to three sentences on what the module is and does, and a link to the child doc (e.g. `See [Comment panel](comment-panel.md).`). Keep the doc's language and style. Leave the rest of the doc untouched.

4. **Check.** Nothing from the module is lost: every point is either in the short version or in the child doc. The link resolves.

5. **Report.** Give the child doc's path and the new short version. Do not commit unless the user asks.
