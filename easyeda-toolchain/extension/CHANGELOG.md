# 更新日志

## 1.0.0（2026-08-20）

首个发布版本。

### 新增
- 本地 WebSocket 桥（仅 `127.0.0.1`），令牌鉴权 + Origin 校验（阻断 `null`/`file://` 伪装）
- 多 EDA 窗口管理：按 `order` 分配、随真实焦点切换活动窗口
- 安全序列化：大对象（ArrayBuffer）分块 base64，指数退避重试，心跳保活
- 优雅退出：收到 `shutdown` 通知 EDA 后关闭

### 修复（相对官方 run-api-gateway 1.0.x）
- 安全：阻断 `null` / `file://` Origin（官方允许，属伪装风险）
- 序列化：超大响应分块 base64（官方直接 `JSON.stringify` 会丢数据）
- 稳定性：指数退避（官方无重试）、心跳序号去重、窗口焦点事件驱动活动窗口

### 开源
- 基于 Apache-2.0 fork 官方 `run-api-gateway`，保留 LICENSE/NOTICE 与原作者版权
