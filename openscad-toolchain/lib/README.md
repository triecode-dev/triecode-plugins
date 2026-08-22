# OpenSCAD 插件库目录

本目录是 `OPENSCADPATH` 的指向目标（插件的 cli 工具把 `{pluginDir}/lib` 注入 OPENSCADPATH），
供 `.scad` 里的 `include <BOSL2/std.scad>` 等解析。

- `BOSL2/` — BOSL2 库（56 个 .scad，Apache-2.0，来源见其 README.md）。
  用法：`include <BOSL2/std.scad>` → 解析到 `lib/BOSL2/std.scad`。

不要删除本目录（即使 BOSL2 未打包，OPENSCADPATH 指向空目录也无害——`include <BOSL2/...>`
只是找不到库时清晰报错，不影响裸 OpenSCAD 建模）。
