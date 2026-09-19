# intj

一个以 markdown 文档为交互界面的 AI 编程工作台。

## 文档树

界面的主体是一组有层级关系的 markdown 文档。

- 项目开始时只有一个 markdown 文档。
- 工作过程中逐渐添加更多文档，形成层级。
- 这些文档是人与 agent 之间的交互界面。

## 操作

- **开启子文档**：从一个 md 文档中开启新的文档，即添加子模块。
  - 在文档中选中一段文字后，除了「添加 comment」按钮，还会出现「开启子文档」按钮。
  - 点击「开启子文档」会新建子文档，并把选中的文字变成指向它的超链接。
  - 点击这个超链接会跳转到子文档，comment 栏和 terminal 栏也同时切换到子文档。
- **开启 AI 会话**：从一个 md 文档中开启新的 AI 会话。一个新的 AI 会话 = 一个新的 worktree。
- **合并会话**：快速合并任意个 AI 会话（merge）。

## Agent 会话

Agent 会话本身和 Claude Code CLI 一样，不需要变化。

## 与底层 agent 解耦

intj 对底层的 chat interface 无感。底层可以换成 Claude Code、Codex、Hermes 等。

## Skill 库

intj 以插件 `intj` 的形式提供一个 skill 库，安装后 skill 自动带 `intj:` 前缀：

- `intj:update-docs`：更新文档，让 md 文档反映当前的工作状态。
- `intj:open-worktree`：开 worktree，在 `.intj/worktrees/<id>` 下为新的 AI 会话创建分支 `intj/<id>`。
- `intj:merge-worktree`：合并 worktree，把任意个会话分支合并到当前分支并清理。

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
