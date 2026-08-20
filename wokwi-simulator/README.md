# Wokwi 模拟器插件（wokwi-simulator v0.1.0）

用 **wokwi-cli** 在 Wokwi 仿真引擎（云端，与 wokwi.com 同源）上运行嵌入式固件，串口输出实时可测、电路图可校验、自动化场景可断言。适配 TrieCode 插件结构：项目类型 / cli 工具 / 检测 / 设置 / MCP / 视图 / 命令 / 技能。

## 前置

- **wokwi-cli**：`D:\Wokwi\bin\wokwi-cli.exe`（或其它位置，见下方「检测」）
- **WOKWI_CLI_TOKEN**：模拟需要授权。两种方式：
  1. 插件设置页「Wokwi 配置」填 token（注入所有 wokwi 命令子进程 env）
  2. 系统环境变量 `WOKWI_CLI_TOKEN`（MCP 服务器读取）
- **编译固件**：Arduino 项目用 `wokwi_compile_arduino`（需 `arduino-cli` 在 PATH）；ESP32/PlatformIO 等用各自工具链编译后把 wokwi.toml 指向固件

## 用法

1. **新建项目**：「新建项目」选「Wokwi 模拟项目」→ 生成 `{name}.ino` + `wokwi.toml` + `diagram.json` + `libraries.txt`（Arduino Uno + LED 闪烁模板，diagram.json 已通过 `wokwi-cli lint` 验证）
2. **运行模拟**：工具栏「运行模拟」（10s 冒烟）或 AI 工具：
   - `wokwi_lint`（query）校验电路图
   - `wokwi_compile_arduino`（execute）编译 .ino 固件到 build/
   - `wokwi_run`（execute）运行模拟，串口输出流到**底部编译面板**
   - `wokwi_ci_test`（execute）期望/失败文本断言（CI 风格）
   - `wokwi_scenario`（execute）自动化场景（按按钮/改传感器/等串口）
   - `wokwi_screenshot`（execute）部件截图（如 OLED）
3. **看状态**：插件聚合面板「状态」视图显示 wokwi-cli 检测/版本/使用引导

## 检测

`manifest.detection`：`WOKWI_CLI_PATH` 环境变量 / 常见路径 glob（`D:\Wokwi\bin`、`%USERPROFILE%\wokwi\bin`、`C:\wokwi\bin`、`%LOCALAPPDATA%\Programs\wokwi`）→ 校验 `wokwi-cli.exe`。检测结果存 `pluginSettings.<id>.toolchain.active.path`，cli 命令用 `{settings.toolchain.active.path}/wokwi-cli.exe`。

## MCP（实验性）

插件注册 `wokwi` MCP 服务器（`wokwi-cli mcp`），宿主 MCP 管理器以 stdio 连接——AI 可实时交互仿真。需要全局 `WOKWI_CLI_TOKEN` 环境变量（MCP 子进程继承 process.env）。命令路径经宿主 `registerCapabilities` 的 `{settings.*}` 占位符解析为检测到的 cli 路径。

## 目录

```
plugin.json   声明式 manifest（工具/脚手架/检测/设置/MCP/视图/命令/技能）
ui/status.html 状态视图（检测 + 使用引导）
```
