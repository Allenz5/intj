# Skill 库

intj 以插件 `intj` 的形式提供一个 skill 库，安装后 skill 自动带 `intj:` 前缀：

- `intj:update-docs`：更新文档，让 md 文档反映当前的工作状态。读当前分支的 diff，从会话打开的文档或 `main.md` 往下找管这部分代码的文档，就地改成现状（保持原文语言和结构，不写 changelog），最后报告改了哪些文档，不提交。skill 里自带简洁输出规则：先给结果，不叙述过程，不做收尾复述。
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
