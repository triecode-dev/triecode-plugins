# 立创EDA（EasyEDA）桥接插件

把立创EDA（EasyEDA 专业版）接入 TrieCode AI：工程管理、原理图/PCB 设计、器件库搜索、DRC、布线、导出、任意 API 执行。**41 个 AI 工具**，比官方 easyeda-api 顺手（结构化工具封装高频操作，自动规避单位/文档状态/重叠等坑）。内置**确定性原理图自动布局引擎**（AI 给意图，引擎算坐标）+ **一键重排**（redesign）。

## 组件

```
easyeda-toolchain/
├── plugin.json            # 插件清单（MCP 服务器 + 41 个 AI 工具 + 技能 + 视图 + 命令）
├── server/
│   ├── src/               # 桥源码（MCP stdio ⇄ WebSocket 127.0.0.1）
│   │   ├── index.mjs      # MCP 入口 + 工具注册
│   │   ├── bridge.mjs     # WebSocket 桥核心（安全/状态机/优雅退出）
│   │   ├── serialize.mjs  # 安全序列化
│   │   ├── units.mjs      # 坐标单位换算
│   │   ├── docsearch.mjs  # API 参考检索
│   │   └── layout/        # 确定性布局引擎（纯函数，可单测）
│   │       ├── planner.mjs    # 5 阶段编排（铺散→贴脚→标签→合法化→验证）
│   │       ├── attach.mjs     # 贴脚/信号链/并列求解（锚点钳边 + 受约束推让）
│   │       ├── zones.mjs      # 功能分区铺散 + 自动分页
│   │       ├── central-lr.mjs # 中央芯片左右布局
│   │       ├── labels.mjs     # 网络标记四象限防重叠
│   │       ├── occupancy.mjs  # 占用图 + 空位查找
│   │       ├── bbox.mjs       # bbox 归一化 + 引脚估算兜底
│   │       ├── geometry.mjs   # 几何纯函数（同尺核心）
│   │       ├── lint.mjs       # 同尺 lint（检测/验证共用）
│   │       ├── verify.mjs     # 放置验证 + 连通性指纹
│   │       └── intent.mjs     # 布局意图 zod schema
│   ├── build.mjs          # esbuild 打包 → dist/server.cjs（自包含，随插件分发）
│   ├── dist/server.cjs    # 已打包产物
│   └── test/              # 80 个单测（node --test，含布局引擎 + 集成）
├── extension/             # fork 自立创官方 run-api-gateway（Apache-2.0）
│   └── build/dist/*.eext  # 编译产物（随插件分发）
├── assets/triecode-easyeda-gateway_v1.0.0.eext
├── docs/index.json        # 立创EDA API 参考离线索引（由 scripts/build-doc-index.mjs 生成）
├── scripts/               # build-doc-index.mjs / doc-search.mjs
└── ui/                    # status.html（连接状态）/ wizard.html（扩展导入向导）
```

## 架构

```
┌─────────────── TrieCode ───────────────┐      ┌────────────────────┐
│ AI 工具 plugin_easyeda_* (MCP stdio)    │      │ 系统/共享便携 Node   │
│ ←────────────────────────────────────────► {nodeBin}（跨插件共享）  │
└──────────────────────────────────────┘      └────────────────────┘
        │  同一进程
        ▼
┌────────────────────────────────────┐      ┌──────────────────────┐
│ 桥（WebSocket 127.0.0.1 只回环）      │ ◄──► │ 立创EDA 扩展           │
│ token + Origin 校验 + 安全序列化       │  WS  │ triecode-easyeda-gateway│
└────────────────────────────────────┘      └──────────────────────┘
```

- **桥由 TrieCode 托管**：插件启用即起 MCP 进程（也是桥进程），停用即优雅关闭（通知 EDA 扩展）。
- **Node 共享**：`{nodeBin}` 占位符——系统 node ≥18 优先，否则用共享便携 node（`plugins/bin/node`，浏览器/EDA/未来插件复用一份，不重复下载）。
- **安全**：桥只绑 `127.0.0.1`；WS Origin 校验（阻断 null/file:// 防 sandbox iframe 伪装）；HTTP /execute 需 token（默认自动随机，不暴露）。
- **修复官方 BUG**：结果安全序列化（不再丢结果）、重试指数退避（不再 5 次永久停摆）、心跳序号匹配、断线选窗查状态、单例撞端口顺延。

## 布局与布线能力（画图美观）

### ⭐ 一键重排（redesign）

- **`redesign`**（`easyeda_sch_redesign`）：**AI 只调一次**完成「读全量 → 确定性布局 → 批量落图 → 自动布线 → 验证」。主 IC 居中、**电源(VCC)朝上 / 地(GND)朝下**、信号流左到右、外围件贴对应引脚、**器件间强制留 PART_GAP=14 布线通道**（不再贴死导致无法布线）；随后按网络 Steiner 自动布线（信号网先/端点少先），最后用 verify_wiring 自证。**10 分钟逐条编排 → 秒级一次完成**。
- 无网表兜底：真实 EDA 的 `getNetlistFile` 常失败 → 用**网络标记的 net 反推相邻引脚**网络名（`inferPinNetsFromFlags`），连通性照样可用，不再降级散乱。

### 确定性自动布局引擎（AI 给意图，引擎算坐标）

- **`plan_layout`**（`easyeda_sch_plan_layout`）：AI 只表达**语义意图**，坐标由确定性引擎计算并保证不重叠：
  - `anchors` 贴脚：`[{s:"C3",p:"1",t:"U1",tp:"RST"}]` = C3 的 pin1 贴到 U1.RST——引擎按「目标引脚真实坐标 − 卫星引脚相对偏移 + 间距」解坐标，**上/下贴脚钳制宿主 bbox 边缘**（本体必然让开），自然朝向撞宿主自动旋转 180 背向；支持多卫星贴同一脚、递归贴到非锚件
  - `groups` 功能块：`flow` 信号链（按相邻件实际网算间距）、`pair` 并列（等距）、`cluster` 簇
  - `mode` 初始铺散：`central-lr`（单核心芯片左右外设）/ `functional-zones`（多模块功能分区+网格+自动分页）
  - `netFlags`：网络标记随所属引脚平移 + 四象限防重叠、不压器件本体
  - `layout.apply=true` 直接落图；否则返回 placements 供 `sch_modify` 执行（sch 单位）
- **`verify_layout`**（`easyeda_sch_verify_layout`）：同尺门禁——`overlaps`（器件重叠，含间距余量）、`netflagsInsideParts`（标记压件）、`outOfSheet`（越界）、`routingBlocked`（通道堵塞），返回 ok 布尔
- **`sch_list`** 返回归一化 bbox（min<max 保证）+ 同尺重叠检测（修复了 EasyEDA `getPrimitivesBBox` 的 Y 轴反转导致的重叠假阴性）+ 网络标记压件检查
- **`sch_place_component` / `sch_modify`** 放置/移动后**直接返回归一化 bbox + 引脚坐标**
- **`sch_modify`** 用 async 图元模式，**能移动 VCC/GND 网络标记**
- **`sch_get_pins`** 读精确引脚坐标 + **`sch_wire`** 精确画导线（带网络名）
- 技能内置「画图美观规范」：用布局引擎算坐标（禁止心算）/防重叠/留间距/旋转纪律/防整批删线

### 布线（绕障 + 多端点 + 验证闭环）

- **`wire_routed`**（`easyeda_sch_wire_routed`）：两点自动布线——**A\* 绕开元器件/无关引脚**（Hanan 网格 + 拥塞权重 + 四级降级重试），pin 省略自动选距目标最近的端
- **`wire_net`**（`easyeda_sch_wire_net`）：**多端点网络一次连成树**（Steiner 树：Prim-MST + Hanan 网格）——晶振/去耦/电源这类多点网络一次搞定
- **`wire_repair`**（`easyeda_sch_wire_repair`）：布线后**拆线重布**——验证失败网络 → 拆阻挡线 → Steiner 重布，最多 3 轮
- **`verify_wiring`**（`easyeda_sch_verify_wiring`）：**电气自证**——读回导线检查 ①端点精确吸附引脚（≤1sch）②是否穿元器件/引脚 ③每网络闭合性 ④线 net 与引脚 net 匹配。画完线 ok=true 才算电气正确（不再靠截图目视）
- **`wire_delete`**（`easyeda_sch_wire_delete`）：正确删除导线（用 `getState_PrimitiveId`，修 `w.id` 静默失败）

## 开发

```bash
# 桥
cd server && npm install && node build.mjs        # 打包 dist/server.cjs
node --test "server/test/*.test.mjs"              # 跑全部单测

# 扩展（需 Node ≥20.17）
cd extension && npm install && npm run build      # 产出 build/dist/*.eext → 复制到 assets/
```

## 文档索引

```bash
node scripts/build-doc-index.mjs --refs <立创官方references目录> --out docs/index.json
```

索引只含方法签名与极短摘要（功能性事实），不复制官方文档原文。

## 扩展发布（立创扩展广场）

- `.eext`（`extension/build/dist/triecode-easyeda-gateway_v1.0.0.eext`）满足商店 8 条硬性要求：extension.json 全字段 / 自定义图标（软件 LOGO 512×512）/ entry 有效 / README.md / CHANGELOG.md / Apache-2.0 LICENSE / 无隐私
- 上传：https://jlc-ext.com → 扩展管理 → 扩展上传（首次自动建命名空间，同 uuid 后续版本归入）

## 连接稳定性（已修）

- **窗口列表递增 / 反复弹"已连接"根因**：扩展每次握手 `crypto.randomUUID()` 生成新 windowId → 软件端按 windowId 去重，重连变新窗口；每次连接都弹 toast。
- **修复**：windowId 首次生成后持久化（`sys_Storage`），重连复用同一 UUID；toast 仅首次连接弹；**心跳超时 5s→30s**（EDA 后台/忙时 5s 误判断连 → 周期重连）；重连原因 toast（heartbeat timeout）供诊断。

## 致谢

- EDA 扩展 fork 自立创官方 [`easyeda/eext-run-api-gateway`](https://github.com/easyeda/eext-run-api-gateway)（Apache-2.0，版权 `[2024] JLCEDA`），见 `extension/NOTICE`。
- API 参考来自立创官方扩展 API 文档（https://prodocs.lceda.cn ），方法签名为官方公开的功能性接口信息。
- 产品名不含 EasyEDA/嘉立创EDA 商标；仅在功能描述与开源标题中提及原作者。
