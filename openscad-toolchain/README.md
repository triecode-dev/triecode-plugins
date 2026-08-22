# OpenSCAD 工具链插件（openscad-toolchain v0.1.1）

把 **OpenSCAD 程序化建模** 交给 AI：写 `.scad` → 三视角 PNG 预览（AI 看图自纠）→ 渲染导出 STL / 3MF（打印 / 切片）。适配 TrieCode 插件结构：项目类型 / cli 工具 / 检测 / 一键安装 / 命令 / 技能，内置 BOSL2 库。

## 前置

- **OpenSCAD**：三种方式其一：
  1. 本机已装（检测 `OPENSCAD_PATH` 环境变量 / `%PROGRAMFILES%` 等常见路径 / `openscad.com`）
  2. 插件面板「一键安装」下载**最新官方便携版**到插件目录（免安装，带实时进度条）
  3. 手动在插件设置指定路径
- 无需额外库（BOSL2 已随插件内置，`OPENSCADPATH` 自动指向）

## 用法

1. **新建项目**：让 AI「新建一个 3D 模型」→ 自动创建 OpenSCAD 项目（`.scad` 脚手架 + 可调参数常量）
2. **预览自纠**：AI 工具 `preview` 渲染三视角 PNG → `analyze_image` 看图检查尺寸/形状 → 改常量重渲
3. **导出打印**：定稿后左侧栏「导出 STL」（当前模型）或 AI 工具 `render`（STL/3MF/AMF）
4. **手动调整**：左侧栏「在 OpenSCAD 中打开」在 GUI 里查看/编辑当前模型

## AI 工具

- `render` / `render_variant`（-D 单参数覆盖）/ `render_set`（customizer 多参数变体）：导出 STL/3MF/AMF
- `preview`：三视角 PNG（imageOutput 自动挂图给 AI 看）
- `validate`：语法 + 参数检查（`--check-parameters`）
- `openscad_gui`：打开 OpenSCAD GUI 加载指定 .scad
- `version`：查询检测到的 OpenSCAD 版本

## 检测与一键安装

`manifest.detection`：`OPENSCAD_PATH` 环境变量 / `%PROGRAMFILES%`、`%PROGRAMFILES(X86)%`、`%LOCALAPPDATA%\Programs\OpenSCAD` glob / 便携候选（`plugins/bin/openscad`，zip 顶层版本目录自动定位）→ 校验 `openscad.com`。`manifest.installer`：`files.openscad.org/snapshots/` 目录动态最新（`OpenSCAD-*-x86-64.zip`）下载解压到插件 bin（国内提速，进度三阶段）。

## 命令（左侧栏 plugin.panel）

- **在 OpenSCAD 中打开**：`openscad.exe {activeFile}`（GUI 加载当前模型，detached 启动即返回；GUI 程序 spawn 已修复远程/虚拟机窗口不显示）
- **导出 STL**：`openscad.com -o {out} --export-format binstl {activeFile}`（当前模型导同名 .stl）

## 输出路径约定

所有工具 `file`/`out` 均为**相对工作区**路径（含项目目录前缀，与 `read_file` 同约定，如 `model1/model1.scad`）。⚠️ OpenSCAD 不自动创建输出目录——用子目录（如 `build/`）需先创建。
