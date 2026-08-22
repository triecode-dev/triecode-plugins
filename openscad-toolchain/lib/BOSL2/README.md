# BOSL2 库（56 个 .scad 文件）

来源：https://github.com/BelfrySCAD/BOSL2 （master，2026-08-22 拉取）
许可：Apache-2.0（见上游仓库 LICENSE）。

仅包含库根目录的 .scad 库文件（`std.scad` 入口 + 依赖链），不含 docs/tests/examples，
体积约 4.4MB。宿主把 `{pluginDir}/lib` 注入 OPENSCADPATH，`include <BOSL2/std.scad>`
即解析到本目录。升级：重新拉取上游 master 根目录 *.scad 覆盖即可。
