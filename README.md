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

- **文档栏**：显示当前 md 文档，是界面的主体。选中文字可以添加 comment、开启子文档或 split doc，右键可以开启 AI 会话，点击超链接跳转到子文档。详见[文档栏](doc-panel.md)。
- **comment 栏**：显示当前文档的 comment，每条 comment 对应一个 AI 会话，卡片上显示会话状态，可以打开终端、Merge 或 End 会话。详见[comment 栏](comment-panel.md)。
- **terminal 栏**：显示当前文档的 AI 会话终端。默认打开一个直接在主干上的 AI 会话，关掉会话终端后回到它。
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
