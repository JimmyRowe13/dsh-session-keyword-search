# dsh-session-keyword-search

跨**全部**会话的关键词检索——那种"记得原话、忘了是哪个会话"时最想要的东西。

它不新增第二个入口，而是**接管侧边栏那个搜索框**：输入 `大麦 x-sign`，用的还是现成的搜索界面，列出来的却是真正聊过这件事的会话。

## 为什么需要它

DSH 自带的搜索是 SQLite FTS5 + `unicode61` 分词。一段连续中文会被当成**一个 token**：
含 `大麦协议劫持已在真机验证通过` 的文档搜 `大麦` 命中 0，`会话搜索` 搜 `搜索` 也命中 0。
本插件把这两个搜索方法换成子串索引，中文、英文、混排一视同仁。

## 它做什么

- **子串召回**：对小写化文本列做 `LIKE`，没有分词、没有最短词长、不用记短语语法。
- **会话级 AND**：空格分词，每个词只要在该会话**任意消息**里出现即可；`"引号短语"` 要求整段出现在同一条消息里。
- **按会话排序**：命中消息多的在前，其次看会话最近活动时间，同分时当前工作区优先。
- **按来源过滤，而不是靠猜**：每条 `user/message` 都带 `data.source.kind`——`user` 是你打的字，`dsh-mnemon`/`runtime-context`/`time-context`/`skill-catalog`/`tool-jobs` 都是注入。只有 `userSourceKinds`（默认 `["user"]`）里的来源会进索引；`assistant/message` 只取 `text` block，**思考过程（reasoning）从不入索引**。
- **按段落切片**：一条消息按空行切成 block 再入库，长段落按行再切，命中片段因此能精确定位到一段而不是整条消息。
- **热的快路径**：首次搜索建一次派生的 SQLite 索引（一张 message 表），之后只重读 revision 变过的会话。
- **结果行高亮**：搜索框里的词会在结果列表里用 `<mark>` 标出来。
- **点开就定位**：点一条结果，会话打开后会滚动到那条命中消息并闪一下；超出已加载范围时先向上翻页，最多翻 `revealAttempts` 次，找不到就安静地停在默认位置。

## 安装

```bash
# 在本仓库目录
node scripts/install.mjs --tgz ./dsh-session-keyword-search-0.1.0.tgz
# 然后重启 DeepSeek Harness
```

脚本会先备份 `<profile>/package.json`，写入依赖与 `dsh.profile.bundles` 条目，再跑包管理器；`--dry-run` 只打印将要写入的内容。**不动安装目录**，所以 DSH 升级不会冲掉插件。

卸载：

```bash
node scripts/uninstall.mjs            # 保留索引
node scripts/uninstall.mjs --drop-index
```

## 配置

字段全部可选；bundle 自带的 `cordis.patch.yml` 就写的是这些默认值。

| 字段 | 默认 | 含义 |
|---|---|---|
| `path` | `<dataHome>/storages/session-keyword-search/index.db` | 派生的 SQLite 索引。 |
| `dataHome` | `$DSH_HOME`，否则 `~/.dsh` | 默认路径的基准目录。 |
| `takeover` | `auto` | `off` 表示完全不接管，也不建索引。 |
| `includeToolEvents` | `false` | 是否连 `tool/call`、`tool/result` 一起索引。 |
| `injectedPrefixes` | 内置名单 | 视为机器注入的用户消息前缀。 |
| `injectedPatterns` | `[]` | 追加的正则（源码字符串），同样视为注入。 |
| `excludeSessionIds` | `[]` | 永不进索引的会话。 |
| `snippetChars` | `240` | 片段长度（码点）。 |
| `maxTokens` | `8` | 查询词预算。 |
| `refreshDebounceMs` | `5000` | 两次语料对账的最小间隔。 |
| `uiHighlight` | `true` | 在侧边栏结果行里高亮查询词（浏览器端增强）。 |
| `uiReveal` | `true` | 点开结果后滚动到命中消息并闪烁。 |
| `revealAttempts` | `20` | 定位时最多向上翻页的次数。 |
| `userSourceKinds` | `["user"]` | 视为"真人发言"的 `source.kind` 白名单；注入来源不会进索引。 |

在 profile 自己的 patch 里按 id 覆盖：

```yaml
- id: session-keyword-search
  config:
    takeover: off
```

## 为什么它在升级时不容易碎

- 语料只走**公开服务**：`ctx.sessionQuery.listSessions()`、`ctx.sessionQuery.readSession(id)`，以及可选的 `ctx.sessionPersistence.stat(id)` 修订号。插件既不知道会话日志放在哪，也不解析 zstd 帧格式，更不拼路径。
- 它**增强运行中的 `sessionQuery` 实例**（`ctx.effect` 在卸载时还原原方法），不替换服务行；版本不兼容时最坏结果是"退回原样"，而不是 profile 起不来。
- 每次搜索三级降级：**我们的索引 → 原提供方 → 会话标题/工作区子串**，失败会记录到设置页。

## 设置页

`设置 → 会话关键词检索`：显示索引路径、会话数、消息数、索引文本体积、上次同步计数、最近错误，并提供**重建索引 / 删除索引 / 刷新**。它通过 `/dsh-session-keyword-search` RPC 通道与主机侧通信。

通道注册结果会写到索引目录旁的 `rpc-registration.json`；如果设置页报 `HTTP 405`，先看这个文件——它记录了 `connection`/`webServer` 是否可见、注册是否成功、失败原因。

设置页打不开时，运维可以不依赖它：

```bash
node scripts/status.mjs            # 看索引状态 + 注册结果
node scripts/status.mjs --rebuild  # 直接按磁盘会话重建索引
node scripts/status.mjs --clear    # 清空索引
```

## 验证

`scripts/verify.mjs` 是独立验收脚本：直接从磁盘会话库喂给索引器，打印每组的命中会话与片段，不需要启动 DSH。

```bash
node scripts/verify.mjs --rebuild --queries "槟榔 价格" "沉静式翻译 气泡" "大麦 x-sign"
```

真实 profile 实测（106 个会话、48.5k 个事件）：可索引消息 2,114 条、文本 1.25 MB；全量冷建约 2.5s，热查询 16–60ms。

在**运行中的 harness** 里，可用一次启动探针把插件通过真实服务看到的东西写进 `%TEMP%/dsh-session-keyword-search-selftest.json`：

```bash
DSH_SESSION_KEYWORD_SEARCH_SELFTEST="槟榔 价格" dsh <profile> ...
```

## 已知限制

- 当前会话最后 1~2 个 turn 可能还没落盘，刚说的话要等 flush 才搜得到。
- 高亮与定位是基于 DOM 契约（`[role="treeitem"]`、`[data-chat-node-key]`、`[data-conversation-scroll]`）的启发式增强，**失败只丢增强、不影响搜索**；消息文本被 markdown 改写严重时可能对不上原文前缀。
- 旧格式会话若没有 `data.source`，按"真人发言"处理（否则老会话会全部搜不到）；需要更严格时可把 `userSourceKinds` 设为空数组来关闭白名单。
- 引擎判定为损坏的会话日志（例如 `step/start does not match the open turn`）会被**逐条跳过**，不会影响其它会话；跳过的数量显示在设置页「无法读取、已跳过的会话」一行，同一修订不会重复重试。
- 索引不加密：消息文本以明文存在 SQLite 里。可在设置页删除，或用 `--drop-index`。
- 结果行用的是 DSH 自己的结果组件，插件只提供会话 id 与片段，和 stock 提供方一致。

## 许可

MIT。
