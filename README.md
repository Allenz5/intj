# intj

一个以 markdown 文档为交互界面的 AI 编程工作台。

## 文档树

界面的主体是一组有层级关系的 markdown 文档。

- 项目开始时只有一个 markdown 文档。
- 工作过程中逐渐添加更多文档，形成层级。
- 这些文档是人与 agent 之间的交互界面。

## 操作

- **开启子文档**：从一个 md 文档中开启新的文档，即添加子模块。
- **开启 AI 会话**：从一个 md 文档中开启新的 AI 会话。一个新的 AI 会话 = 一个新的 worktree。
- **合并会话**：快速合并任意个 AI 会话（merge）。

## Agent 会话

Agent 会话本身和 Claude Code CLI 一样，不需要变化。

## 与底层 agent 解耦

intj 对底层的 chat interface 无感。底层可以换成 Claude Code、Codex、Hermes 等。

## Skill 库

intj 提供一个 skill 库，包括：

- 更新 README
- 开 worktree
