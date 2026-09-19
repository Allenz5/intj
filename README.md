# intj

一个以 markdown 文档为交互界面的 AI 编程工作台。

## 文档树

界面的主体是一组有层级关系的 markdown 文档。

- 项目开始时只有一个 markdown 文档。
- 工作过程中逐渐添加更多文档，形成层级。
- 这些文档是人与 agent 之间的交互界面。

## 界面

界面由四栏组成：

- **目录栏**：在最左边显示项目的目录树，可以折叠起来。

另外三栏始终对应同一个 md 文档：

- **文档栏**：显示当前 md 文档，是界面的主体。
  - 选中一段文字后，弹出「添加 comment」和「开启子文档」两个按钮。
    - **开启子文档**：新建子文档（即添加子模块），并把选中的文字变成指向它的超链接。
  - 在任意位置右键，弹出右键菜单。
    - **开启 AI 会话**：从当前文档开启新的 AI 会话。一个新的 AI 会话 = 一个新的 worktree。
  - 点击指向子文档的超链接，跳转到子文档。
- **comment 栏**：显示当前文档的 comment。
- **terminal 栏**：显示当前文档的 AI 会话终端。
  - **合并会话**：快速合并任意个 AI 会话（merge）。

切换文档时，comment 栏和 terminal 栏跟着切换到新文档。

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
