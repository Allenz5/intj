# Skill 库

intj 以插件 `intj` 的形式提供一个 skill 库，安装后 skill 自动带 `intj:` 前缀：

- `intj:update-docs`：更新文档，让 md 文档反映当前的工作状态。
- `intj:open-worktree`：开 worktree，在 `.intj/worktrees/<id>` 下为新的 AI 会话创建分支 `intj/<id>`。
- `intj:merge-worktree`：合并 worktree，把任意个会话分支合并到当前分支并提交，保留 worktree 和分支。
- `intj:split-doc`：拆分文档，把一个模块在当前文档里缩成简洁版本，详细内容移到链接过去的子文档。可选参数是附加条件。

安装到 Claude Code：

```sh
claude plugin marketplace add Allenz5/intj
claude plugin install intj@intj
```

安装到 Codex：

```sh
codex plugin marketplace add Allenz5/intj
codex plugin add intj@intj
```
