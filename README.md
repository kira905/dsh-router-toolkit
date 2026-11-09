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
   换会话接着干还有一份**接续头**（3~4 行：在聊什么 + 一条不许改写的原话），不用重读全文。

> 这是**提炼重写的最小骨架**，不是任何生产版本的副本：同名生产件 2,525 行（非空），
> 这里 1,150 余行。骨架的目标是"让人读懂这套形状并照着改"，不是"拿来直接顶生产"。
>
> 0.4.0 起再加三件**上游本来就在跑、此前不在本仓**的新增面（`router-lazy` / `yearring-index` / 可选插件），
> 它们不在上面那 2,525 行里。

> ### 一条命令跑起来
> ```bash
> git clone https://github.com/kira905/dsh-router-toolkit
> cd dsh-router-toolkit
> node router-act.mjs --help     # 只看用法，不碰任何东西
> ```
> 本仓零第三方依赖 —— **CLI 不用 `npm install`**：拉下来直接用 `node` 跑就是全部安装步骤。
> 要真读车况得先备好 `/api` cookie 密钥，见下面「装上它」；装成包 / 挂插件见「可选插件」一节。

> ### 它不附带什么（先看清楚，省得装完失望）
>
> 这套开源出来的是**能用的工具 + 装完自检 + 设计文档**。有两块**不在开源范围里**：
>
> 1. **「自己盯着活干」的那套引擎**：定时调度、队列盯守、管家日报、自主决定要不要动手 —— 这几件还没整理出来放（整理完会陆续放）。它的**设计本身是公开的**，写在 [`ops-handoff-design`](https://github.com/kira905/ops-handoff-design) 仓里，想自己实现的人照着做得到。
> 2. **「出事喊到人」的通道**：企业微信、语音播报这类 —— **不随开源发布**。
>
> 所以：装完你拿到的是一套**能用的工具**，不是一个会自己上班的管家。

---

## 它是什么 / 不是什么

**是**：一套 CLI（受控动词 + 巡检 + 两个读数件）+ 一份 agent preset 样板 + 一个**可选**的 web 插件。零第三方依赖，只用 Node 内置模块。

**不是**：不是框架、不是服务、不是看板、不是 cron。它不替你调度，也不替你存卡 ——
它读你能读到的那些状态，然后**在边界内**做事。

```
router-act.mjs     受控动词（受控手唯一的动作入口）
router-guard.mjs   巡检三项（置顶复位 / 归档保护 / cwd 还在）
lib/say.mjs        最小投话（两闸：不投自己 / 不投已归档）
lib/router-head.mjs 接续头压缩（最近三句 + 一句摘要 → 3~4 行的头）
lib/vision-gaps.mjs 愿景差距排序（各线目标 vs 看板现状，回答"下一步该推哪条"）
router-lazy.mjs    偷懒四档判据（哪条主线该被催、催什么；只读）
yearring-index.mjs 愿景档目录索引（每线一行：ask 分档计数 + 排第一那条）
plugin/            可选 web 插件（「收口并清空」按钮：先落档、再原地压缩）
lib/config.mjs     阈值解析（env > 配置文件 > 缺省，一个口）
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
| `brief` | 三行摘要（车况一行 + 建议先看哪条 + 要你定的事）；`--gaps` 另起一段「愿景差距」 | **零写入** |
| `card-show` | 只读一张卡的一句话摘要（含 description 的「待拍板」段） | **零写入** |
| `say` | 指名投一句话给某个会话；默认 dry-run | 唯一投递腿 = `lib/say.mjs` |
| `digest` | 把一条线的一句结论追加进结论档（幂等键 = 线名 + 日期）；`--ask` 带一个 ≤6 字符的愿景指针；`--auto` 给每条有活主线机械写一行 | 结论档追加一行 |
| `reset` | 槽位 + 待办事项写成「接续头」追加进结论档 | 结论档追加一段 |
| `wake` | **stub**：本骨架不含"按 thread 唤醒卡片"那套数据面 | —— |

```bash
# 只读，随便跑
node router-act.mjs brief
node router-act.mjs brief --gaps        # 再问一句"下一步该推哪条线"
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

### 第 3 行「要你定」：失败卡不上桌

`brief` 的第 3 行只放**真需要你拍的**：

- 明细 **≤3 条**（`ROUTER_BRIEF_ASK_MAX` / `brief.askMax` 可调），超出折叠成计数 —— 一屏清单糊住人等于没报。
- **执行失败卡不当主项**：那是机器该自己重试/归因的事，只进折叠计数（`其中失败卡 N 件机器自管`），一条都不进明细。
  三条判据任一命中即算（看板同 id 的卡是 `failed` / 问句带固定失败文案 / 选项恰为那三个）——
  卡被归档之后看板状态查不到，所以不能只靠第一条。判据的**文案与状态名都是可配的**（见下节）。
- 排序：真等拍板的（`attentions[]` 里未答）在前，待验收的卡其次；两档内部一律「等得最久的先摆」。

### 槽位与接续头：一行一条线，收口顺手续上

结论档有两种成分：**结论区**（`- 日期｜线名｜一句结论｜ask=…｜ref：…`，只增不改）和**接续头**
（`reset` 写的那一段：一行槽位 + 未答的事 + 怎么继续）。槽位就是"每条线最近一句结论"，**上限 16 行**。

```bash
# 收口时带一个愿景指针（指向该线愿景件里某条 ask 的 id；≤6 字符）
node router-act.mjs digest --line 发布线 --text "回滚演练补上了" --ask a1 --apply

# 一步把"每条有活的主线"各写一行（零模型调用：只有取数 + 字符串拼接）
node router-act.mjs digest --auto --apply
```

两件事值得记住：

1. **收口写完会顺手刷接续头的槽位段** —— 只换「#### 一行槽位」那一段，时间戳 / 待办清单 / 结论区历史行
   一个字节都不动；渲染结果与档里相同就**不写盘**（同一天重跑，档的 sha 不变）。档里从没跑过 `reset`
   ⇒ **不发明新段**（`no-slot-section` 如实报）。
2. **有活的线优先占名额**：槽位按日期降序取 16 行，但给了一份"当前有活"的线名集合时，**活线先占满**、
   静线（今天更早收口过、此刻无在途卡）只在不满时补位。不然一条静线能把在跑的线挤出名额。
   不给这个集合 ⇒ 行为与纯日期口径**逐字相同**（`reset` 的既有输出靠这条钉着）。

### 陈旧账：读取侧兜底销账（**fail-open**，别当 bug）

`brief` / `status` 的「等拍板 N 件」来自状态件里的 `attentions[]`。卡干完/归档/删掉之后，
那条 attention 可能还挂着 —— 于是它成了**假信号**。本件在**读取侧**兜一层：

- 未答 attention 的卡 **不在账本里**（已归档 / 删卡 / 从不存在）**或** 账本里 **已是 `done`**
  ⇒ 记进 `stale`、**不计入 open**；第 1 行会补一句「另有 N 件卡已归档/完成/不在板，不计入」。
- 🔴 **账本读不到 / 解析不出来 ⇒ 一条都不销**（open 原样返回，输出里明写「陈旧账没核成：
  账本读不到，按原样全算」）。这是**故意的 fail-open**：宁可多报一件，也不误销一件真在等你的板。
  所以看到"N 件"比你以为的多，先看这句是不是"没核成"，那说明账本路径没给对（`ROUTER_LEDGER_FILE`，缺省
  `<home>/task-board/ledger-v2.json`，**可选**）。
- 它**只读**：不写状态件、不写 `answeredAt`、不删 attention、不联网。

### 愿景差距：`brief --gaps`

`brief` 那三行回答"现在什么在跑"，`--gaps` 回答"**下一步该推哪条线**"——它在三行之后**另起一段**：

```bash
node router-act.mjs brief --gaps          # 人读
node router-act.mjs brief --gaps --json   # 机读（visionGaps[] / visionView / visionWarnings）
```

数据来源 = 一个目录里**每条线一个 JSON**（缺省 `<工作目录>/docs/vision/`，`ROUTER_VISION_DIR` 可改）：

```json
{ "line": "发布线", "humanDoc": "docs/发布线.md",
  "asks": [ { "id": "a1", "kind": "self-todo", "what": "把回滚演练补上" } ] }
```

- `kind` → 档（**A** = 卡在你手上 / **B** = 能力缺口 / **C** = 你自己就能干）走一张可覆盖的映射表
  （配置 `vision.kindTiers`；缺省给了三个示例，**未登记的 kind 一律按 B 计并在 `warnings` 里点名**，不许静默吞）。
- 「该线排第一的 ask」= **C ＞ B ＞ A**：只有整条线只剩 A 时，才印成「等操作者：…」——
  卡在人手上的事不该抢走"该推"的位置。
- 排序公式的六个权重 + Top-N + 截断字数全部可配（见下节）；同分按线名排 ⇒ **可复现**，不靠数组顺序碰运气。
- 只读：读目录、读看板车况、读一张可选的「操作者优先级清单」（命中 +5）。**不写任何文件、不改任何卡**。

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
- **写后回读带 settle 重试**：RPC 先回、`workspace.json` 后落盘 ⇒ 立刻回读会假报警（最多等 8×250ms）。
- 本件是**三项**；生产版五项里另两项（会话身份漂移 / 入站通道 Bot ready）判的是**某一种接入方式的部署事实**
  （具体平台 appId + 本机日志目录）⇒ 不进本仓，理由写在 `router-guard.mjs` 文件头。

---

## 接续头压缩（`lib/router-head.mjs` · bin `dsh-router-head`）

换会话接着干，最贵的一步是"重读全文才知道刚才在聊什么"。这个件把这件事压成一份**头**：

```
# 接续头 · 2026-11-05 09:30
- 在聊：刚聊到版本号怎么升
- 原话：（无）
```

**3~4 行、整份 ≤400 码点**（可调）。新会话开局读它就够，不必重读全文。

```bash
node lib/router-head.mjs --from-session <文件|目录|sessionId|id前缀>        # 只打印，不写盘
node lib/router-head.mjs --from-session <...> --write ./heads              # 写到 <目录>/<会话id前8位>.md
node lib/router-head.mjs --check ./heads/1a2b3c4d.md                      # 校验（不通过 rc=1）
node lib/router-head.mjs --selftest                                       # 29 条夹具，不联网
```

两条判据（这是本件的设计，别改着改着改掉）：

1. **「在聊」是摘要位，不是原话的前缀。** 判据 =「换一种说法，意思变不变？」不变 ⇒ 写摘要；变了 ⇒ 才整句抄进「原话」。
   离线没有模型就如实写 `（离线：需模型判定）`，**绝不拿原话前缀冒充摘要**。
2. **「原话」行不许截断。** 整句 + 其余行超预算 ⇒ **整句不录**（写「（无）」），并记 `verbatimDropped`。
   截一半的句子既不是摘要也不是原话，读的人会当它是原话 —— 比不写更坏。

另外三条实测出来的坑（代码注释里也留着）：

- assistant 消息的 `reasoning` 段**也带 `text`** ⇒ 必须按 `part.type === 'text'` 过滤，否则把思维链抄进文件；
- `user/message` 的 message 就是 `event.data` 本身，`assistant/message` 才是 `event.data.message`；
- 注入侧务必用 `forInjection()` 去掉首行时间戳 —— 否则头每轮都变，前缀缓存每轮失效。

**它不做什么**：不自动清空上下文、不删会话、不归档（`--write` 只写那一份头文件）；没有一个原料 ⇒ 返回 `null`，
读侧一个字都不加（干净启动）。

---

## 判「这条主线停下没动」（`router-lazy.mjs` · bin `dsh-router-lazy`）

`brief` 数的是停留天数，判不出"谁该被催、催什么"。这条命令把一份会话表 + 一份看板 + 一份接力台账
摆在一起，输出「该催谁」清单。四档的含义（**别混着用**，混了就催错）：

| 档 | 什么情况 | 该怎么处理 |
|---|---|---|
| `lazy` | 会话没在跑，可这条线有 **todo** 卡 / 有未完成的交接 / 标题自己标着【待续】 | 该催：投话让它去办那几张卡 |
| `backlog` | 会话没在跑，这条线只有 **backlog** 卡 | 催**规划**不催跑：让它把卡移进 todo，或说明这批为什么不做 |
| `handoff` | 标题标着【已交接】且线内还有活 | 别投给这一棒（会被"已交接闸"挡）：起新棒，或改投接手的会话 |
| `stuck` | 会话闲置超过阈值，可这条线还有 **running / review** 卡 | 卡在跑、会话却死了：先核会话真死没，再决定重跑还是改投 |

另有一列「今日已催 N 次」：读 `<home>/router-ops.jsonl` 数**本地当天**真投的 say/wake
（演练、失败、别的动词都不算）。同一条线今天已经催 3 次还没动 ⇒ 该上报给人，而不是催第 4 次。

```bash
node router-lazy.mjs                    # 人读一屏
node router-lazy.mjs --json             # 机读（数组永远是全量，不受 --top 影响）
node router-lazy.mjs --idle-hours 6      # stuck 阈值（默认 3 小时）
node router-lazy.mjs --selftest          # 32 条夹具断言，不连生产、不碰网络
```

取数失败（会话表 / 看板 / 台账任一读不动）⇒ **rc=3，且一个字都不说"没事"**。把"取数失败"降级成
"没人偷懒"是这类工具最容易犯的假绿，这条判据就是挡它的。

线名从哪来？默认两路证据（接力台账 `chains[].mainline` + 标题令牌），都不命中的线进 `orphanLines`
（有在途卡但没有在册会话：只报不催）。要换成别的来源就注入：

```js
import { analyze } from './router-lazy.mjs';
const r = analyze({
  sessions, tasks, ledger,
  resolveLine: (s) => ({ line: myIndex.lookup(s.sessionId), lineSource: 'my-index' }),
});
```

**排期的 todo 不算待办**：`schedule.enabled && nextRunAt > now` 的卡记进 `cards.scheduledTodo`，
不判 `lazy`（它在等窗口，催它 = 白打扰）；排期**已过点**的仍算 todo，理由里另写一句「排期已过点」。

---

## 愿景档目录索引（`yearring-index.mjs` · bin `dsh-router-yearring`）

一个目录，一条工作线一份 `*.json`（`{ line, humanDoc, asks: [{ id, kind, what }] }`），本命令把它扫成
「每线一行」：asks 的 A/B/C 计数、排第一的那条 ask、人读档在不在、JSON 好不好。

```bash
node yearring-index.mjs                  # 人读表
node yearring-index.mjs --json           # 机读
node yearring-index.mjs --dir ./docs/vision
```

`kind` → 档：`blocked-by-owner` ⇒ **A**（卡在操作者手上：只上桌，不进"该推"）、
`capability-gap` ⇒ **B**、`self-todo` ⇒ **C**（自己就能干，最该推）；别的词按 B 计并**点名**（不静默吞）。

**它只读**：不建档、不改档、不补字段。坏 JSON / 缺字段 / 目录不存在三档一律**报黄、rc=0** ——
一个坏文件不该带崩整轮索引。目录从哪来：`--dir` > `ROUTER_VISION_DIR` > 配置 `vision.dir` >
`<cwd>/docs/vision`（与 `brief --gaps` 同一口径，不另造一套）。

---

## 可选插件：收口并清空按钮（`plugin/`）

给主会话的输入框加一个「收口」按钮，一键两步、**顺序不能反**：

1. 跑 `router-act reset --apply` —— 把槽位与待定项落进结论档（**这一步是保命**，先落档再清空）；
2. 调宿主的 `compaction.compactNow()` —— 原地压缩，会话 id 不变。

失败语义写死在代码里：落档失败 ⇒ **绝不压缩**（报错里明说「保命优先」）；落档成功但压缩失败 /
没有压缩服务 / 没有可压历史 ⇒ 一律报「⚠️ 已落档，但这次没压（原因）」，**不报成功**。
只有人点才动手（无定时器、无事件订阅、无打开即压）；非 Router 会话直接拒，并给一句人话原因。

装法（包级，CLI 与插件各走各的：CLI 进 `bin`，插件按 `dsh.bundle.patch` 加载，两边互不依赖）：

```bash
npm i @kira905/dsh-router-toolkit
```

组合里挂上（`cordis.patch.yml` = DSH 读的插件挂载清单 / `dsh.profile.bundles` = profile 自己的「启动时自动挂我」清单）：

```yaml
- id: dsh-router-reset-btn
  name: '@kira905/dsh-router-toolkit/plugin'
  config:
    routePrefix: /api/dsh-router-reset                       # 可改
    routerActPath: ~/.dsh/tools/dsh-butler/router-act.mjs     # 可省，缺省按顺序找
```

`router-act.mjs` 解析顺序：`DSH_ROUTER_ACT` env > 与本包同目录的 `router-act.mjs` >
`<home>/tools/dsh-butler/router-act.mjs`。

**路由前缀两边要一致**：client 半边读 `window.__DSH_ROUTER_RESET_PREFIX__`，不写就两边都用缺省值。
三处 id 也要对齐（本文件的 `id`、`plugin/client.js` 里 `__ModuleLoader__.load({ id })`、
`dsh.client` 的期望名），对不齐的表现是"加载了但没注册"。

---

## 阈值全是可配的（env > 配置文件 > 缺省）

配置文件缺省 `<home>/router-config.json`（`ROUTER_CONFIG_FILE` 可指到别处）；**文件不在 = 没配置**，不创建、不报错；
非法值**回落缺省并打一条 warning**，绝不返回 `NaN` 让下游拿它去比大小。

| 阈值 | 环境变量 | 配置键 | 缺省 |
|---|---|---|---|
| 「要你定」明细条数 | `ROUTER_BRIEF_ASK_MAX` | `brief.askMax` | 3 |
| 失败卡：状态名 | `ROUTER_FAILED_STATUSES` | `brief.failedStatuses` | `failed` |
| 失败卡：问句文案 | `ROUTER_FAILED_Q_PATTERNS` | `brief.failedQuestionPatterns` | `执行失败（failed）`（半角括号变体也算） |
| 失败卡：选项组合 | `ROUTER_FAILED_OPTION_SETS`（`;` 分组 / `/` 分项） | `brief.failedOptionSets` | `重试/归档/先放着` |
| 待验收：状态名 | `ROUTER_REVIEW_STATUSES` | `brief.reviewStatuses` | `review` |
| 愿景目录 | `ROUTER_VISION_DIR` | `vision.dir` | `<工作目录>/docs/vision` |
| 优先级清单文件 / 字段 | `ROUTER_PRIORITY_FILE` / `ROUTER_PRIORITY_KEY` | `vision.priorityFile` / `vision.priorityKey` | `<home>/router-state.json` / `ownerPriority.items` |
| 愿景差距 Top-N / 截断字数 | `ROUTER_GAP_TOP` / `ROUTER_GAP_TEXT_CHARS` | `vision.top` / `vision.textChars` | 3 / 40 |
| 权重：C 类 / 在途 / 每天 / 封顶 / A 类 / 优先级 | `ROUTER_GAP_W_ASKC` / `_INFLIGHT` / `_ACTIVITY` / `ROUTER_GAP_ACTIVITY_CAP_DAYS` / `_ASKA` / `_PRIORITY` | `vision.weights.*` | 3 / 2 / 0.5 / 7 / −0.2 / 5 |
| 接续头：整份码点 / 「在聊」码点 | `ROUTER_HEAD_MAX_TOTAL` / `ROUTER_HEAD_MAX_TOPIC` | `head.maxTotal` / `head.maxTopic` | 400 / 60 |

> 不给就用缺省 —— 开箱即用。要改就改配置，**别改代码**（"改代码"是最贵的一种配置）。
> 每个值取自哪一层，`makeResolver().trace` 会逐条告诉你（`env` / `config` / `default`）。

几个**只有环境变量**的入口（它们是"路径/开关"，不是阈值）：

| 环境变量 | 干什么 | 缺省 |
|---|---|---|
| `ROUTER_LEDGER_FILE` | 卡账本（**只读**），用来判"这条未答 attention 的卡还在不在板、是不是已完成" | `<home>/task-board/ledger-v2.json`；读不到 ⇒ 陈旧账**一条都不销** |
| `ROUTER_BOARD_HEADERS` | 看板 state 端点要额外请求头时给一个 JSON 对象串（本件**不猜**任何私有头名） | 不加头 |
| `ROUTER_LOG_DIR` | 结论档目录（缺省 `<工作目录>/docs/year-rings`） | 见左 |
| `ROUTER_LAZY_SESSIONS_FILE` / `_BOARD_FILE` / `_LEDGER_FILE` / `_OPS_FILE` | `router-lazy` 的夹具注入口（`--selftest` 用，生产别设） | 不设 = 走 rpc / 真实文件 |
| `DSH_ROUTER_RESET_PREFIX` / `DSH_ROUTER_ACT` | 插件：路由前缀 / `router-act.mjs` 位置 | `/api/dsh-router-reset` / 自动按顺序找 |

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
- **接续头只压不判**：离线器具没有模型 ⇒「在聊」只能写 `（离线：需模型判定）`。摘要要谁来写、写得好不好，
  是**写侧**（宿主插件 / 调用方）的事；本件保证的是"取得到原料、形态合法、体积可控、不抄思维链"。
- **愿景缺口不替你算目标**：它只读你写好的愿景件并排序；愿景件本身（这条线要往哪走）得你自己写。
- **结论档只增不减**：按月开档、不自动轮转（自动截断 = 丢审计，与"每个动作留一行"的卖点自相矛盾）。
  按年手工归档即可。
- **同日同一条线改结论会被幂等跳过**：幂等键是**去重键**，不是"更新键"。要改就手工改档。
- **`digest --auto` 不编结论**：它取的是卡标题（最近一张 `done` 卡的标题；没有就退化成「状态词：最近一张卡」），
  是**机械摘取**、零模型调用。想要"一句话真结论"，用 `--line` 自己写。
- **槽位是 16 行硬上限**：满了就滚动，谁出窗由 `--auto` 逐条打印（不悄悄截断）；这不是"摘要能力"。
- **`--json` 不保证所有字段稳定**：0.x 阶段，字段只加不改，但别把它当契约。
- **行数不是判据**：这套骨架的价值在"形状对不对"，不在"多少行"。

---

## 许可

AGPL-3.0-or-later，见 [LICENSE](LICENSE)。

## 相关

- 英文说明：[README.en.md](README.en.md)
- 设计取舍与不做什么：[docs/DESIGN.md](docs/DESIGN.md)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)
