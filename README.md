# TrieCode Plugins

TrieCode 官方插件集（开源版）——面向嵌入式和电子设计自动化的 AI 工具链插件。

> **需要 Triecode 宿主**：这些插件运行在 [TrieCode](https://triecode.com)（AI 软件开发 IDE）的插件系统内，
> 通过宿主提供的统一 Node 运行时（`{nodeBin}`）、MCP 与命令驱动机制工作。开源免费可审计，闭源商业软件亦可在 Apache-2.0 下自由集成。

## 目录

| 插件 | 说明 |
|---|---|
| [arduino-cli-toolchain](arduino-cli-toolchain/) | Arduino CLI 官方工具链（编译 / 上传 / 板卡管理） |
| [browser-toolchain](browser-toolchain/) | 浏览器自动化（Playwright MCP） |
| [esp-idf-toolchain](esp-idf-toolchain/) | ESP-IDF 嵌入式开发工具链 |
| [stm32-cube-toolchain](stm32-cube-toolchain/) | STM32Cube 裸机脚手架（CMSIS 器件支持 + 编译/烧录） |
| [wokwi-simulator](wokwi-simulator/) | Wokwi 在线仿真器（虚拟串口 / 自动化测试 / 截图） |
| [plugin-dev-toolchain](plugin-dev-toolchain/) | 面向开发者的插件开发脚手架（AI 创建插件） |
| [easyeda-toolchain](easyeda-toolchain/) | 立创EDA(EasyEDA) 深度集成：原理图自动布局与 A\* 绕障布线引擎、40+ 工具、EDA 端扩展 |

## 官方与第三方

- **本仓库** = TrieCode **官方**插件（组织账号维护，软件内一键安装）
- **第三方插件**：由社区维护，通过 GitHub `triecode-plugin` topic 发现，**不进官方市场**（安全：插件以用户权限运行，官方市场仅收录可审计代码）

发布 / 贡献你的插件见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 快速开始

1. 安装 TrieCode（≥ v1.2.4）
2. 在插件市场安装需要的插件（或从本仓库源码构建）
3. 每个插件目录内 README 有详细使用说明

## 插件结构

统一遵循 TrieCode 插件规范：

```
<plugin>/
  plugin.json          # 插件清单（能力声明：MCP / CLI / 工具 / 设置项）
  README.md            # 使用说明
  assets/              # 图标等资源
  ui/                  # 状态/配置面板（宿主 WebView 内嵌）
  server/              # （如适用）MCP 服务器源码（Node，自包含单文件构建）
  docs/                # （如适用）离线 API 参考索引
```

## 安全说明

- 插件在宿主用户权限下运行；安装插件前请确认来源可信。
- 密钥类配置（如 Wokwi token）通过用户设置的 `{settings.*}` 占位符注入，**不硬编码、不随包分发**。
- 本仓库不包含任何生产密钥、凭据或内网地址。

## License

本仓库整体遵循 [Apache License 2.0](LICENSE)。

- 各部分版权与第三方来源见 [NOTICE](NOTICE)。
- 立创EDA/EasyEDA 相关代码 fork 自立创官方 `run-api-gateway`（Apache-2.0），见
  [easyeda-toolchain/extension/NOTICE](easyeda-toolchain/extension/NOTICE)。
- STM32 器件支持文件来源与许可见 [stm32-cube-toolchain/device-support/LICENSE](stm32-cube-toolchain/device-support/LICENSE)。

产品名与商标：TrieCode 为郑州芯弦智能技术有限公司的商标/产品名。本仓库不包含 TrieCode 核心闭源代码。