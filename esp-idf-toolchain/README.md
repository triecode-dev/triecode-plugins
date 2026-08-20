# ESP-IDF 工具链

TrieCode 官方 ESP-IDF 嵌入式工具链插件：图形化 Kconfig 配置、编译、烧录、目标芯片管理、串口日志，全面接入 AI Agent。

## 功能

- **Kconfig 配置**：`kconfig` 能力（交互式 menuconfig / 保存 / 生成 sdkconfig）
- **编译**：`compile` 能力（`idf.py build`，`{settings.toolchain.active.path}/tools/idf.py`）
- **烧录 / 目标芯片**：`upload` 能力（`idf.py flash`，支持 `-p` 端口 / `-b` 波特率 / monitor）
- **串口日志**：`serialLog` 能力
- **AI 工具**：自动检测复用本机已装 ESP-IDF（可一键下载官方安装器）

## 依赖

- 本机已装 ESP-IDF 工具链（检测复用），或通过插件引导安装官方安装器
- 由用户设置 `{settings.toolchain.active.*}`（路径 / tools 路径 / python 环境）注入环境变量

## 使用（在 TrieCode 中）

1. 安装并启用本插件
2. 配置 ESP-IDF 路径（设置 → ESP-IDF 工具链 → active path / tools path）
3. 打开一个 ESP-IDF 项目，即可让 AI Agent 配置 / 编译 / 烧录 / 看串口

## License

Apache License 2.0。见仓库根 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)。