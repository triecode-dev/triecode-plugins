# 贡献指南（第三方插件发布）

本仓库承载 **TrieCode 官方插件**。第三方插件通过 GitHub 去中心化分发，并由官方审核决定是否收录进官方市场。

## 官方 vs 第三方

| 类别 | 归属 | 分发方式 |
|---|---|---|
| **官方插件** | `triecode-dev/triecode-plugins` | 本仓库源码 + 软件内插件市场一键安装 |
| **第三方插件** | 贡献者自己的 GitHub 账号 | 自建/ fork 仓库 + 打 `triecode-plugin` topic |

## 发布你的第三方插件（3 步）

### 1. 建仓库
在你自己（或个人/公司组织）的 GitHub 账号下创建插件仓库。建议结构：

```
<your-plugin>/
  plugin.json    # TrieCode 插件清单（必填，能力声明）
  README.md      # 说明：功能 / 安装 / 使用
  LICENSE        # 建议 Apache-2.0（与官方一致）
  server/        # 如适用：MCP 服务器源码
  ui/            # 如适用：设置/状态面板
  assets/        # 图标等
```

> `plugin.json` 格式参考本仓库任一官方插件（插件清单声明「能力 / MCP / 工具 / 设置项」）。

### 2. 打 GitHub topic
给你的仓库添加 **`triecode-plugin`** topic（GitHub 仓库页 → Settings → Topics）。
这样用户和其他开发者可以在 GitHub 上通过检索 `triecode-plugin` 发现你的插件：

> `https://github.com/search?q=topic%3Atriecode-plugin&type=repositories`

### 3. 声明归属
- 你的仓库 README 注明"非 TrieCode 官方插件，由 \<作者> 维护"
- 若希望官方在官网"社区插件"区展示，可提交一个 [issue](https://github.com/triecode-dev/triecode-plugins/issues/new)（标题含 `[community-plugin]`），附仓库地址 + 一句话说明
- 官方会审核后放入官网社区区（**不会**并入官方市场 / 官方插件仓库）

## 官方插件合作（进入官方市场）

若你希望插件成为**官方**插件（软件内一键安装），需要：
1. 插件通过官方安全与质量审查（插件以用户权限运行，代码须可审计、无恶意行为、无密钥硬编码）
2. 通过 [issue](https://github.com/triecode-dev/triecode-plugins/issues/new)（标题含 `[official-candidate]`）或联系官方
3. 双方确认后，官方从你的仓库采纳并合入 `triecode-dev/triecode-plugins`，进入官方市场

**官方市场不考虑：** 含密钥/凭据、要求特权执行、行为不可审计、违反第三方版权的插件。

## 安全底线（所有插件必须遵守）

- ❌ 不硬编码任何密钥 / 凭据（用 `{settings.*}` 用户配置注入）
- ❌ 不含内网地址 / 本地绝对路径 / 个人信息
- ✅ 第三方版权素材必须带 LICENSE / NOTICE 声明
- ✅ 安装前在 README 明示插件能力与权限（尤其会执行命令/访问网络的）

## 官方插件仓库结构

```
<official-plugin>/
  plugin.json    # 插件清单
  README.md      # 使用说明
  assets/        # 图标
  ui/            # 设置/状态面板（宿主 WebView）
  server/        # MCP 服务器源码（Node，自包含单文件构建）
  extension/     # （easyeda 等）配套 EDA/外部扩展源码
  docs/          # 离线 API 参考索引
```

License：本仓库 Apache-2.0。第三方插件须自带 LICENSE。