# Arduino CLI 工具链

TrieCode 官方 Arduino 工具链插件：通过 `arduino-cli` daemon 提供编译、烧录、库管理、板卡管理、串口监控能力，全面接入 AI Agent。

## 功能

- **编译 / 验证**：`compile` 能力（avr-gcc 输出解析），支持电量编译失败自动 AI 修复
- **烧录**：`upload` 能力（支持串口/DFU/J-Link 等多种编程器）
- **板卡管理**：`board-manage`（搜索/安装/卸载板卡核心）、`board-select`（选择目标板）
- **库管理**：`library-manage`（搜索/安装/卸载第三方库）
- **平台管理**：`platform-install`（Arduino 平台核心）
- **串口监控**：串口列表、串口日志

## 依赖

- 运行架构：`arduino-cli daemon`（grpc），由宿主按插件 `backends` 声明自动启动
- 编译链：`%LOCALAPPDATA%\Arduino15`（官方 Arduino 数据目录，与 arduino-cli 共用）
- 插件启用时自动下载 arduino-cli（见 `plugin.json` dependencies）

## 使用（在 TrieCode 中）

1. 安装并启用本插件（插件市场）
2. 打开一个 Arduino 项目（`.ino`）
3. 选择板卡（工具 → 选择目标板），即可让 AI Agent 编译 / 烧录 / 管理库

## License

Apache License 2.0。见仓库根 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)。