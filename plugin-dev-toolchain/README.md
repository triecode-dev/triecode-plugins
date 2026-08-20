# 插件开发工具链（Plugin Dev）

让 AI 帮你创建 TrieCode 插件：描述功能 → 生成骨架 → 校验 → 安装到本地。

## 能力

- **AI 工具**（对话即用，无需手动操作）：
  - `plugin_dev_create`：生成插件骨架（plugin.json + README）
  - `plugin_dev_validate`：校验 manifest 是否合规
  - `plugin_dev_install`：安装本地插件目录到软件
- **Skill「创建插件」**：AI 对话框输入 `/创建插件` 或直接描述需求，AI 引导完成创建
- **项目类型**：「新建项目 → TrieCode 插件」生成骨架（手动路径，不占左侧栏）

## 使用流程

1. **描述需求**：AI 对话框「帮我创建一个把 Markdown 转 PDF 的插件」
2. **AI 生成**：AI 调 `plugin_dev_create` 生成骨架 → `write_file` 完善 manifest → `plugin_dev_validate` 校验
3. **安装**：`plugin_dev_install` 自动安装（或「插件管理 → 从文件夹安装」）
4. **启用**：「插件管理 → 已安装」启用，工具/技能即生效

## 手动路径

「新建项目 → TrieCode 插件」→ 生成 plugin.json + README 骨架 → 用 AI 或编辑器完善 → 从文件夹安装。

## 安全

- AI 安装前强制 `validateManifest` 校验（非法 manifest 拒绝安装）
- 安装 ≠ 启用：装完需到插件管理启用（与所有插件一致）
