# dsh-router-toolkit

**一个只下命令、不亲自施工的主会话，需要一只握得住的手。**

这套工具给"总机式"的主会话一套**受控动词**：它想干任何事，只能跑这几条命名的命令 ——
投一句话给某条线、把一句结论沉进档里、出一屏车况。它自己没有写代码、建卡、改状态的手。

三句话概括它想解决的事：

1. **"想越界也没手"是可验证的，不是承诺** —— 工具面在组合层就少了 `write` / `edit` / 提问工具，
   每个写动作各只有一条腿。你可以去读 `presets/router/agent.cordis.yml` 自己数。
2. **每个动作留一行，谁拍的都查得到** —— 动作流水里带 `decidedBy`：这个决定是它自己拍的小决定，
   还是人派下来的，分开记。
3. **上下文不死** —— 一行槽位（每线 1 行）+ 结论档 + 手动重置：过程不进上下文，车况每次现跑。

> 这是**提炼重写的最小骨架**，不是任何生产版本的副本：同名生产件 1,263 行（非空），
> 这里 460 余行。骨架的目标是"让人读懂这套形状并照着改"，不是"拿来直接顶生产"。

---

## 它是什么 / 不是什么

**是**：一套 CLI（受控动词 + 巡检）+ 一份 agent preset 样板。零第三方依赖，只用 Node 内置模块。

**不是**：不是框架、不是服务、不是看板、不是 cron。它不替你调度，也不替你存卡 ——
它读你能读到的那些状态，然后**在边界内**做事。

```
router-act.mjs     受控动词（受控手唯一的动作入口）
router-guard.mjs   巡检三项（置顶复位 / 归档保护 / cwd 还在）
lib/say.mjs        最小投话（两闸：不投自己 / 不投已归档）
lib/host-rpc.mjs   最小宿主 RPC 客户端（自签 /api cookie）
presets/router/    agent preset 样板（人格 + 插件声明）
docs/patch-snippet.yml   把它挂进宿主组合的最小片段
```

---

## 装上它

### 前提

- Node.js ≥ 20（用到内建 `fetch`、`AbortSignal.timeout`、`zlib.zstdDecompressSync`）。
  本仓**零第三方依赖**，不需要 `npm install`。
- 一个能跑的 DSH 宿主实例（本工具调它的 `/api` RPC）。
- **`/api` cookie 的签名密钥**：`DSH_RPC_COOKIE_SECRET`（32 字节、Base64 或 Base64URL 都行）。
  > 为什么要它：看板状态与 RPC 走的是宿主的 `/api` 鉴权门（cookie 名形如 `dsh-auth-<sha256(authority)>`，
  > HMAC-SHA256 签名）。**匿名直连会 403** —— 这不是缺陷，是鉴权门在工作。
  > 本骨架**不读**任何本机凭据文件、不猜密钥位置：只认显式参数或这个环境变量。
- 可选：`DSH_WEB_URL`（默认 `http://127.0.0.1:3080`）、`DSH_HOME`（默认 `~/.dsh`）。

### 三十秒验证

```bash
node router-act.mjs --help            # 看动词白名单
node router-guard.mjs --help          # 看三项巡检
node router-act.mjs status --json     # 读得到看板就说明 cookie 配对了
```

跑不起来时它**会直说原因**（`状态取不到：HTTP 403（这个端点要 /api cookie ⇒ 给 cookieSecret 或 DSH_RPC_COOKIE_SECRET）`），
不会拿上次读数冒充，也不会静默返回空表。

---

## 七个动词

| 动词 | 干什么 | 写面 |
|---|---|---|
| `status` | 一屏车况（按线聚合：在跑 / 待办 / 等验收 / 失败 + 待拍板件数） | **零写入** |
| `brief` | 三行摘要（车况一行 + 建议先看哪条 + 要你定的事） | **零写入** |
| `card-show` | 只读一张卡的一句话摘要（含 description 的「待拍板」段） | **零写入** |
| `say` | 指名投一句话给某个会话；默认 dry-run | 唯一投递腿 = `lib/say.mjs` |
| `digest` | 把一条线的一句结论追加进结论档（幂等键 = 线名 + 日期） | 结论档追加一行 |
| `reset` | 槽位 + 待定事项写成「接续头」追加进结论档 | 结论档追加一段 |
| `wake` | **stub**：本骨架不含"按 thread 唤醒卡片"那套数据面 | —— |

```bash
# 只读，随便跑
node router-act.mjs brief
node router-act.mjs status --max-lines 30
node router-act.mjs card-show --card 3f9a1c2e

# 投话：缺省 dry-run（只预览，不投）；--apply 才真投
node router-act.mjs say --to 前端线 --text "把发布脚本的版本号核一遍"
node router-act.mjs say --to 前端线 --text "把发布脚本的版本号核一遍" --apply

# 收口一条线的结论（同一天同一条线重复跑不会重复写）
node router-act.mjs digest --line 前端线 --text "v0.3 发完了" --ref issues/42 --apply

# 收口整屏（产出「接续头」；**不清空任何东西**）
node router-act.mjs reset --apply
```

> 结论档落在 **`<工作目录>/docs/year-rings/router-<YYYYMM>.md`**（按月一档；`ROUTER_LOG_DIR` 可覆盖这个目录）。
> 它是运行期产物、不随包发布 —— `.gitignore` 已挡住。

**参数也是白名单**：每个动词只认自己那几个参数（表在 `lib/flags.mjs`）。出现不认识的 flag ⇒ `rc=2`，
并打印该动词用法 —— **一个字节都不写盘**（写动词带 `--apply` 也一样拦）。所以 `--aply` 这类笔误
不会被当成功（0.1.1 修的正是这个：0.1.0 里未知 flag 被静默吞掉，`digest` 会照写结论档）。

### 投话的两道闸

`say` 之所以安全，是因为它在**打印预览之前**就拦：

1. **不投给自己** —— 目标 == 当前会话（`DSH_SESSION_ID`）⇒ 拒绝，rc=4。dry-run 也拦。
   （预览看着完全正常、实际投给自己，是最难自察的一种错。）
2. **不投给已归档会话** —— 目标在 `<home>/storages/workspace.json#global.archivedSessionIds` 里 ⇒ 拒绝，rc=5。

第 2 条不是洁癖：投给已归档会话是**白投** —— 宿主会在 `agent/pre-step` 拒掉这次投递、回合以
`blocked` 收尾、**不发模型请求**，而投递接口仍回"已受理" ⇒ 投递方拿到"已通知"的假象，
消息在界面里根本看不见。这类"看着成功、实际没人读"的错最难自察。

> ⚠️ 别把它与「认领 / 恢复一个会话会让它继续跑」混为一谈 —— 那是 `session.create` 路径的行为，
> 不是 `session.prompt` 路径的行为。本件用的是 `session.prompt`。

**读不到就明说**：归档名单读不到 ⇒ 打印「⚠️ 读不到归档名单，本次未做归档闸」后继续；
取不到 `DSH_SESSION_ID` ⇒ 打印「⚠️ 取不到 DSH_SESSION_ID，本次未做自校验」后继续。**绝不静默放行。**

第三道「已交接」闸（标题带某个标记就不投）属于**某些部署自己的交棒语义**，不是通用能力 ⇒
做成可选开关，默认关：`ROUTER_SAY_HANDOFF_GATE=1`。

---

## 巡检三项

```bash
node router-guard.mjs --router-cwd <你的工作区目录>            # dry-run：只报该修什么
node router-guard.mjs --router-cwd <你的工作区目录> --apply    # 真修
node router-guard.mjs --router-cwd <...> --json                # 机读
```

| 项 | 判据 | 能自己拨回来吗 |
|---|---|---|
| 置顶复位 | 目标工作区在 `workspace.json#global.workspaceIds` 里不是第一个 | 能（RPC `workspace.insertBefore`；顺序即置顶，**没有硬 pin 字段**） |
| 归档保护 | `archivedSessionIds` 含当前主会话 | 能（RPC `workspace.unarchiveSession`）—— 只认当前那个，**不去复活**历史旧会话 |
| cwd 还在 | 目标目录存在 **且** 会话 `header.cwd` 仍是它 | 不能，只报警（**不自动建目录**：免得将错就错把会话钉到空目录上） |

- 默认 **dry-run**；四种结局 `ok` / `已复位` / `报警` / `unknown`，单点异常记 unknown 继续下一项。
- **幂等**：修好后再跑一次 = 全 ok、零动作、零新增报警。
- **报警去重**：站着不动的那条默认 6 小时只落一行（`--no-dedupe` 可关）。
- **失败即让路**：`workspace.json` 读不到 = 环境没就绪 ⇒ 退出码 **3**（调度侧通常把 3 当"让路"：
  本轮跳过、不算失败）。"有报警"不是脚本失败 ⇒ 仍是 0。
- 单实例锁：巡检自己抢一把 tick 锁（带 ttl 自愈），手工直跑与定时任务撞车时后来者让路。

---

## 它对应哪套设计

这套工具不是一个新发明的框架。它的每个构件，都是**业界早已反复验证的通行做法**
（编配者只下命令不执行、事件分诊、每动作一行处置记录、谓词化待办、带复核期的授权、
订阅式扇出）。DeepSeek Harness 团队的[架构思路一文](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)
从设计约束出发，把这套东西讲得更完整；我们是在另一条路上（多主线运维）撞出来的同一套骨架。
逐条对照：

> ⚠️ **口径（引原文自己的话，不替它表态）**：
> 原文自陈「**并非对 DeepSeek Harness 现有产品功能的介绍**」，并写了
> 「**相似的设计约束会导出相似的架构选择**」。
> ⇒ 本仓**不代表官方立场**、**不是官方实现**、**也不主张谁先谁后**：两条独立的路长出了相近的结构。

| 这套设计里的构件（通行做法） | 本仓的对应物 | 我们做了什么 |
|---|---|---|
| 主会话 / 编配者 **只发命令不执行** | `router-act.mjs` 的封闭动词白名单 | 不给它写权：`tool-fs` 把 `write` / `edit` 用 config 关掉、没有提问工具、所有写面各只有一条腿（投话 / 唤醒 / 零看板写入） |
| **事件源 → 分诊 → 派单**（三段式） | `status` / `brief` 现算 + 一次模型判断 | 不新造对象模型：取数走 CLI 现算，判断交给模型，**故意不做 Trigger 表** |
| **处置记录每动作一行** | `router-ops.jsonl` | 每个动作一行，含 `decidedBy` = 谁拍的 |
| **待办谓词化** | 从状态文件的 `attentions[]` 读"谁在等人拍板" | **不 grep 卡面文本猜** —— 文本里顺手写三个字就能虚增待办，这条踩过 |
| **授权带复核点** | 每个动作带 `decidedBy: router / owner` | 派活时能回答"这个决定是谁拍的、依据是哪张授权纸" |
| **订阅式扇出 + 恢复已结束的卡** | `wake`（本骨架只给 stub） | 真做的话三道闸要原样保留：单条消息最多唤 N 张 / 同卡冷却 / 一键关 |

> 📌 **术语口径**：上表左列里的那些专名（Sources / Assessor / Assignment / Attention / Mandate /
> Subscription 等）取自**我们自己的领域模型命名**，**不是该文原文用语**。原文正文里并没有这几个词 ——
> 它讲的是同一类结构的约束与取舍。别把它们当成"那篇文章里的概念"来引。

**不抄的**：每个 thread 起一个会话、完整的 Trigger 对象模型、带副作用的处置码。
理由见 [docs/DESIGN.md](docs/DESIGN.md) —— **会话是人的入口，不是 thread 的容器**；
一个"能改代码的 Router"和"一条普通主线"没有区别，只会多一层转发。

---

## 怎么挂到自己实例上（preset 样板）

三份文件在 `presets/router/` 与 `docs/`：

```
presets/router/preset.yml        名字 / 描述 / 顺序
presets/router/agent.cordis.yml  人格 + 插件声明（工具面收紧就在这一份里）
docs/patch-snippet.yml           把它挂进宿主 composition 的最小片段
```

**步骤（一次重启生效）**

1. 把 `presets/router/` 整个目录放到你实例的 agent preset 目录下。
2. 打开宿主的 cordis patch 文件，把 `docs/patch-snippet.yml` 里 `- insert:` 整段贴进去，
   并把 `agent.cordis.yml` 的内容**整体再缩进 4 格**填进 `plugins:` 下（片段里只内联了前两条做样例）。
3. 重启一次宿主。
4. 验收：新开会话时能选到该 preset；且**工具面确实是收紧的**（试着让它改一个文件 —— 它应该说没这个能力）。

**⚠️ 哪条路才真生效（本机 0.2.1 实测 · 2026-11-03）**

上面的步骤 1 和步骤 2 是**两条路**，而**不是每条路在所有宿主上都通**：

| 路 | 怎么走 | 什么时候生效 |
|---|---|---|
| **内联**（步骤 2） | 把 `- insert:` 段贴进宿主的 cordis patch 文件 | **一定有** —— 走宿主组合，与 preset 目录无关 |
| **目录**（步骤 1） | 把 `presets/router/` 放进实例的 agent preset 目录 | **只有当宿主 compose 了 `@deepseek-ai/dsh-agent-presets`（复数包 · 负责扫目录）时才生效**。主包自带的单数包 `dsh-agent-preset-registry` 只认代码里 `register()` 进来的定义，**不扫目录** |

⇒ **不确定就先只走内联**（步骤 2），它不依赖目录。
⇒ 别拿「目录里文件都在」当验收 —— 那只证明你复制成功，不证明宿主读到了。**验收只看两件事**：新会话能选到该 preset；工具面确实收紧（让它改文件，它说没这个能力）。
⇒ 反过来也要记住：一旦宿主 compose 了那个复数包（或换了会扫目录的主包），**目录版立刻变成第二个真源** ⇒ 那时两份不同步就会"静默飘"（实际生效的是目录版，你以为改的是内联版）。所以下面那条同源纪律别丢。

**怎么整段回滚**

- 删掉 patch 里 `- insert:` 那一段 + 删掉 preset 目录里的 router 目录 → 重启一次。改之前先备份这两个文件。
- 只撤工具面收紧：删掉 `tool-fs` 的 `config:` 两行（`write` / `edit`）+ 同步目录版 → 重启一次。
  > ⚠️ `tool-fs` 那一行里 `read` / `read_image` 与 `write` / `edit` 是同一行注册的 ——
  > **整行删会把读也删掉**。要只读，用 config 关，别删行。

**口径会飘的地方**：preset 目录版与 patch 内联版是"同一份东西的两个位置"，改了任一边不同步会很安静地飘
（症状：界面能选到，但工具面和你以为的不一样）。自检思路：抽出两边的 `- id:` 行序列做集合比较。

---

## 已知限制

- **`wake` 是 stub**：按 thread 唤醒卡片依赖看板侧的卡片分组数据 + 三道闸（单条上限 / 冷却 / 一键关），
  那是另一套数据契约，本骨架不假装自己有。没有 thread 的活请改用 `say`。
- **结论档只增不减**：按月开档、不自动轮转（自动截断 = 丢审计，与"每个动作留一行"的卖点自相矛盾）。
  按年手工归档即可。
- **同日同一条线改结论会被幂等跳过**：幂等键是**去重键**，不是"更新键"。要改就手工改档。
- **`--json` 不保证所有字段稳定**：0.x 阶段，字段只加不改，但别把它当契约。
- **行数不是判据**：这套骨架的价值在"形状对不对"，不在"多少行"。

---

## 许可

AGPL-3.0-or-later，见 [LICENSE](LICENSE)。

## 相关

- 英文说明：[README.en.md](README.en.md)
- 设计取舍与不做什么：[docs/DESIGN.md](docs/DESIGN.md)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)
