# 交接文档生成器

`handoff-document-generator` 是一个本地 Codex 插件。0.2.0 保留 `/handoff`、`/交接文档` 和自然语言交接功能，并增加上下文额度检测、压缩前兜底、安全状态机、秘密扫描以及连续编号的新任务交接。

## 数据来源与 98% 判定

自动检测只接受 Codex Hook 通过标准输入提供的 `session_id` 与 `transcript_path`。运行时会验证：

- `transcript_path` 的真实路径位于 `CODEX_HOME/sessions` 内；
- 文件是普通、非符号链接文件；
- 文件名和 `session_meta.payload.id` 都与 `session_id` 精确一致；
- 最新合法事件必须是 `type=event_msg`、`payload.type=token_count`。

计算只使用：

```text
payload.info.last_token_usage.input_tokens
------------------------------------------------
payload.info.model_context_window
```

不会使用累计的 `total_token_usage`，也不会读取 `state_5.sqlite`、`logs_2.sqlite` 或界面截图。图 1 的“23% 已用 / 59k / 258k”与上述结构化数据一致；导出的中英文 UI 文本解析器只供用户显式粘贴状态和合成测试使用，不会抓取桌面。

阈值用整数比较 `used * 100 >= total * 98`，因此总量为 258400 时：

- 253231：未达到 98%；
- 253232：达到 98%。

## 为什么还需要 PreCompact

本机证据显示 Codex 可能在约 78% 时先执行原生上下文压缩，所以精确 98% 在部分任务中根本不可达。插件注册两个彼此独立的插件 Hook：

- `Stop`：结构化用量确实达到 98% 时，以 `trigger=exact_98` 请求自动交接；
- `PreCompact`：第一次阻止压缩并写入一次性待处理状态，随后 `Stop` 以 `trigger=precompact` 请求交接。它不会谎称已达到 98%。

第二个尚未完成的 `PreCompact` 会直接放行，`stop_hook_active=true` 也始终放行，避免永久循环。即时重复 `Stop` 去重；过期请求最多恢复一次，总请求次数上限为 2。

## 安装与信任

插件安装或更新后，由 Codex 从插件根目录自动发现 `hooks/hooks.json`。Hook 会执行：

```text
node "${PLUGIN_ROOT}/scripts/context-handoff.mjs" hook
```

首次启用以及 Hook 内容变化后，Codex 会要求用户明确审阅并信任 Hook。不要绕过信任提示；可在 Codex 插件设置中撤销或禁用 Hook。Hook 未信任、被禁用或运行失败时，手动 `/handoff` 与 `/交接文档` 仍然正常。

开发安装流程应使用 Codex 的插件更新/缓存刷新流程，不要直接修改安装缓存。插件清单没有添加非标准 `hooks` 字段。

## 自动交接流程

Hook 只返回官方控制 JSON，不创建任务。`AUTO_HANDOFF_REQUEST` 由 `generate-handoff-document` 技能处理：

1. 安全检查项目并原子写入 `HANDOFF.md`；
2. 使用本脚本的 `scan` 命令执行确定性秘密扫描；
3. 依次使用任务工具查找项目、创建干净的新任务、设置 `原任务名（续接 N）`、读回验证，并可选导航；
4. 初始提示第一句固定为 `Read HANDOFF.md first and continue the project.`，包含绝对路径、SHA-256 和经扫描的完整内容（大小允许时）；
5. 通过 `checkpoint` 命令推进状态至 `complete`。

项目没有登记时创建 projectless 任务。禁止使用 fork，因为 fork 会复制旧上下文。任务工具不可用时只报告 `HANDOFF.md` 的绝对路径，不会伪报已创建或已导航。

## 隐私与安全

- 状态只写入 `PLUGIN_DATA/context-handoff-v1`，文件名是会话 ID 的 SHA-256。
- 状态不保存标题、转录路径、正文、秘密或原始子任务 ID；子任务 ID 只保存 SHA-256。
- 使用原子锁和原子替换写入，状态保留不超过 7 天，最多 100 条。
- 生成交接文档时禁止读取或复制 `auth.json`、`.env` 值、cookie、token、原始 transcript、隐藏推理、日志、SQLite/JSONL、截图。
- 秘密扫描只输出规则 ID 和行号，不回显命中值；高置信命中会阻止创建新任务。
- rollout JSONL 格式并非稳定 API。未知结构、路径校验失败、读取错误和解析错误全部安全放行，不猜测数据。

## Ralph Loop 共存

这是插件级 `hooks/hooks.json`，不会修改或覆盖 Ralph Loop 的全局 Stop Hook。多个 Hook 可能并发运行；本插件以独立状态目录、`stop_hook_active` 防护和一次性请求保证共存。Ralph Loop 的安装、状态和停止逻辑仍由其自身插件管理。

## 测试

测试只使用临时目录和合成文本，不读取真实会话或秘密：

```powershell
node --test tests/context-handoff.test.mjs
```

还应运行 Codex 的技能与插件校验器，以及：

```powershell
git diff --check
```

测试覆盖精确阈值、结构化数据优先、中文/英文 UI 语义、畸形尾行、路径边界、原子去重、过期恢复、PreCompact 兜底、标题编号、秘密扫描和原手动文档结构。
