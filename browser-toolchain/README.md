# 浏览器自动化（Web Browser）插件

给 TrieCode 的 AI 一个**可控的真实浏览器**：打开网页、点击、填表、抓取内容、截图。
用于在线检索、查文档，以及调试本地 Web 应用（`http://localhost`）。

通过 **Playwright MCP**（`@playwright/mcp`）接入，插件声明一个 MCP 服务器，软件端零改动。

## 前置条件

- **无需预装 Node.js**：系统有 Node（≥18）则用系统的；没有则**自动下载便携 Node 22.14.0**（国内 npmmirror CDN，约 35MB）并用它启动——客户零门槛，不污染系统环境。
- **Microsoft Edge**：直接驱动系统已装的 Edge（`--browser msedge`），**无需下载浏览器内核**。
  插件启动时注入 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`，即使 `@playwright/mcp` 依赖全量 `playwright` 包，
  安装阶段也**跳过 Chromium 内核下载**——首次启动只从 npm 下载包本身，不触碰 Playwright 官方 CDN
  （国内/无代理网络不卡死、不超时）。
  若本机没有 Edge（极少数），可在「设置 → MCP 服务器」把该服务器的 args 里的 `--browser msedge`
  改成 `--browser chromium`，并按下面提示**手动**装 Chromium（因已跳过自动下载）：

  ```bash
  npx playwright install chromium
  ```

## 网络与下载说明

- 首次启用插件会经 `npx` 从 **npm registry 镜像（npmmirror，国内 CDN）** 下载 `@playwright/mcp` + `playwright`（~20MB），之后走 npx 缓存秒起——插件已注入 `NPM_CONFIG_REGISTRY`，无代理/国内网络首次启动不再卡 npmjs.org 慢网。
- **不下载浏览器内核**（驱动系统 Edge，且已跳过 `playwright` 包的 postinstall 内核下载）——不访问被墙的 Playwright CDN。
- 若需换回官方源：在「设置 → MCP 服务器」编辑本服务器 env，去掉 `NPM_CONFIG_REGISTRY` 即可。
- 便携 Node 下载失败时插件卡片显示红点，点「⟳ 重试下载」即可恢复（依赖下载走国内 CDN，失败多为临时网络问题）。

## 安装后 AI 获得的能力

安装/激活插件后，MCP 服务器随软件启动连接，AI 工具列表出现 `mcp__…__browser_*` 工具：

| 工具（Playwright MCP） | 作用 |
|---|---|
| `browser_navigate` | 打开 URL（含 localhost） |
| `browser_snapshot` | 查看页面结构/文本（无障碍树） |
| `browser_click` / `browser_type` | 点击 / 输入 |
| `browser_take_screenshot` | 截图 |
| `browser_wait` / `browser_back` | 等待 / 返回 |

另附带技能「网页浏览与检索」，AI 在需要在线资料时自动使用。

## 安全说明

- `autoApprove` 默认 **false**：浏览器工具执行前需用户确认（可安全浏览）。
  若想更流畅（AI 直接操作页面），可在「设置 → MCP 服务器」把本服务器的 `autoApprove` 打开，
  但涉及提交/删除等不可逆操作仍建议保持确认。
- 浏览器有独立于软件的会话，关闭软件后浏览器进程由 MCP 服务器回收。

## 已知坑（软件端处理，勿回退）

- **便携 Node 需注入子进程 PATH**：`@playwright/mcp` 运行时内部会 spawn `node`，依赖 PATH。MCP SDK 只继承白名单环境变量，便携 node 目录必须由软件端 `createTransport` prepend 到子进程 PATH，否则无 node 电脑报 `"node"不是内部或外部命令`（MCP error -32000）。**依赖软件支持此 PATH 注入**。
- **zip-slip 校验不用反斜杠正则**：Windows 传参给 powershell.exe 反斜杠被剥，`\.` 会退化成任意字符误报；用 `IsPathRooted` + `Combine`/`GetFullPath` 检查。

## 待完善

- 跨平台：便携 Node 依赖当前为 win-x64（`node-v22.14.0-win-x64.zip`）；macOS/Linux 需对应平台 zip（软件支持多平台时再调）
- 更细的工具定义：把浏览器工具声明进 manifest.tools（host `browser` 服务）以纳入 plan 模式裁剪
