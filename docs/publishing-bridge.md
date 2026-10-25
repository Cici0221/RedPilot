# 发布桥协议 v2

RedPilot 当前只实现调用方。发布桥需另行实现，负责自有账号的登录、图集渲染、实际发布和笔记核对；填写 URL 不等于已经连通。

## 配置

服务器环境变量：`REDPILOT_PUBLISH_URL`、`REDPILOT_PUBLISH_TOKEN`。各账号在工作台单独保存发布桥账号 ID；`REDPILOT_ACCOUNT_ID` 仅供旧数据首次迁移。推荐本机或可信服务，不要将服务密钥放进网页。

## 请求

向配置 URL 发送 POST JSON。请求超时 60 秒，不跟随重定向。

```http
Authorization: Bearer <服务器配置的令牌>
Idempotency-Key: <持久化任务幂等键>
Content-Type: application/json
```

```json
{
  "action": "publish",
  "idempotencyKey": "uuid",
  "accountId": "目标账号",
  "jobId": "uuid",
  "post": {
    "title": "标题",
    "body": "正文",
    "tags": ["产品开发"],
    "slides": [{"headline": "页标题", "body": "本页文字"}],
    "brand": "人类补丁",
    "product": "SimHelper",
    "design": "blue-white-v1"
  },
  "noteUrl": null
}
```

`slides` 是原创文字图集的分镜，**不是图片地址**。桥接服务必须将其渲染为真实图片后再提交平台；不可拿参考截图代替成稿。网页预览和 PNG 导出实现在 `public/app.js` 的 `coverSVG` / `png` 函数，尺寸 1200 × 1600。

`action: "verify"` 使用同一 URL、同一账号及同一幂等键，请求结果查询。**verify 绝对不能再次发布**。首次发布前，调用方已将任务意图写入本地文件。

## 成功响应

只有发布桥已经读取并确认目标账号上真实存在的对应笔记时，才返回：

```json
{
  "status": "published",
  "verified": true,
  "accountId": "与请求相同的目标账号ID",
  "noteUrl": "https://www.xiaohongshu.com/explore/0123456789abcdef01234567"
}
```

调用方检查回执 `accountId` 与该任务首次提交的账号完全匹配，再检查 HTTPS、小红书主机名和笔记路径，再标记已核对发布。该检查只校验结果格式，**真实性仍依赖发布桥执行的账号与笔记核对**。

等待平台确认时可以返回 `{"status":"pending"}`。非成功响应、网络异常、超时或无经过核对的链接，都会停在 `uncertain`（待核对），不自动重新提交。

## 必须满足的行为

1. 对账号和幂等键维护持久化结果，重复 publish 只能返回既有任务或结果，不能再次发帖。
2. 每个账号串行发布，按 `accountId` 隔离登录态与浏览器会话。账号失效、验证码、图片不完整时停止提交并给出可查询状态。
3. 真正写入平台前核对目标账号；发布后读取对应笔记，核对标题、图集及账号。
4. 若超时后仍在后台发布，后续 verify 必须能读取该任务的最终结果。
5. 不将“已点击发布”或“请求已接收”当作 verified。

## RedPilot 的任务状态

- `scheduled`：等待时间到达。
- `blocked`：尚未提交，缺发布器、资料版本变化或未审核；可取消，未提交的任务可重新入队。
- `publishing`：请求意图已落盘，正在调用桥。
- `uncertain`：结果需要查询；只可核对，不自动重发或直接取消。
- `published`：桥接服务返回经过核对的笔记 URL。
- `cancelled`：取消未提交的任务。

草稿一旦有活动任务就禁止修改。产品资料变更会撤销未发布草稿的审核状态；发布前再次检查版本，避免使用过期资料。

## 多账号调用方约束

任务的 `accountId` 来自所选账号的外部映射，不使用全局默认号作为兜底。首次提交时会冻结外部账号标识，后续 verify 继续使用同一标识，即使账号被暂停。缺少回执 accountId、账号不匹配或没有真实笔记链接时均为待核对。
