# STM32Cube 工具链

TrieCode 官方 STM32 原生工具链插件：编译 / 烧录 STM32 工程（STM32CubeCLT：CMake + Ninja + arm-none-eabi-gcc + STM32_Programmer_CLI），内置**裸机脚手架**、串口日志，全面接入 AI Agent。

## 功能

- **裸机脚手架**：`device-support/` 提供 STM32 器件支持文件（CMSIS 头 / STM32 器件头 / 启动文件 / 链接脚本），支持 F1（STM32F103xB）与 F4（STM32F401/F411）系列，开箱即用新建裸机工程
- **编译**：`compile` 能力（CMake + Ninja + arm-none-eabi-gcc 多步流水线）
- **烧录**：`upload` 能力（STM32_Programmer_CLI，支持 ST-LINK / 串口）
- **串口日志**：`serialLog` 能力

## 依赖

- 本机已装 STM32CubeCLT 工具链（检测复用），路径经 `{settings.toolchain.active.*}` 注入
- `device-support` 中 ST 器件文件来源与许可见 [device-support/LICENSE](device-support/LICENSE)

## 使用（在 TrieCode 中）

1. 安装并启用本插件
2. 配置 STM32CubeCLT 路径（设置 → STM32Cube 工具链）
3. 新建/打开 STM32 裸机工程，AI Agent 即可编译 / 烧录 / 看串口

## License

Apache License 2.0（含 Device Support 第三方来源说明）。见仓库根 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)。