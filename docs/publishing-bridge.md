# 发布桥协议 v3

RedPilot 已内置 Chrome 图文发布驱动，同时保留通用外部发布桥 v3。下文请求与响应是外部桥契约，不表示已完成真实发布；外部桥仍需另行部署。

## 内置 Chrome 通道与验证边界

`POST /api/accounts/:id/connect-publisher` 只核对当前 Chrome 登录身份与图文入口。严格身份链为创作者中心账号标识 → 目标主页标识 → 公开笔记作者与标题，已做实网只读核验；不在公开文档保存具体账号。`ready` 表示登录身份和图文入口已核，`publishVerified` 仅在真实已发布笔记核验后为 true。

图文驱动已实现，但图片上传、表单填充、点击发布与首篇结果核验尚未实测，未执行真实发布测试。原生文字模板入口虽然可见，当前仍为 `unsupported`，不能据此宣称文字配图已验证。真实 AI 服务同样尚未接通。

内置浏览器操作在状态写锁外由 `nativeQueue` 串行执行，每次发布及最终提交前再次核验目标身份。`runtime/xhs-publisher.json` 以0600权限持久化幂等记录、输入摘要及提交证明：结果未知只允许只读 verify；即使重启也不盲目重发。只有记录证明从未尝试提交时，才允许用户显式 retry。

内置首篇要求用户亲自点击“核对通过”再排期。自动生成稿不能代替这次 owner 核对，首篇会阻塞；只有同一账号取得真实发布核验后才允许自动发布。账号管理可有多个记录，但当前仅使用单个 Chrome 登录态，账号不匹配即停止；并未提供多个小号独立 Cookie/profile 或自动切换会话。

## 外部发布桥配置

服务器环境变量：`REDPILOT_PUBLISH_URL`、`REDPILOT_PUBLISH_TOKEN`。各账号在工作台单独保存发布桥账号 ID；`REDPILOT_ACCOUNT_ID` 仅供旧数据首次迁移。推荐本机或可信服务，不要将服务密钥放进网页。

## 外部桥请求

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
    "contentMode": "image",
    "coverStrategy": "custom",
    "slides": [],
    "images": [{"id": "素材UUID", "name": "产品图", "mime": "image/png", "kind": "image", "data": "base64最终图片"}],
    "sourceAssets": [{"id": "素材UUID", "name": "产品图", "mime": "image/png", "kind": "image", "data": "base64原始素材"}],
    "brand": "人类补丁",
    "product": "SimHelper"
  },
  "noteUrl": null
}
```

`contentMode: "image"` 使用 `coverStrategy: "custom"`。`images` 是按用户选择顺序排列的最终图片，可能为原图、裁切保存图、3D 渲染图或 AI 图片。发布桥应按该顺序上传，首图为封面；网页预览与 ZIP 导出使用同一批原件。审核及排期至少需要一张真实图片，SVG 图标不能充当主图。

`sourceAssets` 附带全部所选图片与图标，供查阅来源；不重复上传到平台。`slides` 仅是可选策划文字，不是最终图片，不据此重新生成固定文字卡。

`contentMode: "text"` 使用 `coverStrategy: "platform_default"`，`slides`、`images`、`sourceAssets` 均为空数组。发布桥需要使用小红书支持的原生文字配图流程，不得默默替换为自制文字卡。该流程尚未实机验证；只有桥接端实现并验证此能力后，才配置 `REDPILOT_PUBLISH_TEXT_ENABLED=true`。未配置时文字稿可审核、排期，实际提交前会阻塞，零提交次数。Web「写长文」入口不能作为原生短文字模板可用的证明。

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

## 外部桥必须满足的行为

1. 对账号和幂等键维护持久化结果，重复 publish 只能返回既有任务或结果，不能再次发帖。
2. 外部桥每个账号串行发布，按 `accountId` 隔离登录态与浏览器会话。账号失效、验证码、图片不完整时停止提交并给出可查询状态。
3. 真正写入平台前核对目标账号；发布后读取对应笔记，核对标题、图集及账号。
4. 若超时后仍在后台发布，后续 verify 必须能读取该任务的最终结果。
5. 不将“已点击发布”或“请求已接收”当作 verified。

## RedPilot 的任务状态

- `scheduled`：等待时间到达。
- `blocked`：确认尚未提交，缺发布器、资料版本变化、未审核或内置首篇尚未由用户核对；可取消，仅有未提交证明的任务可显式重新入队。
- `publishing`：请求意图已落盘，正在调用所选发布通道。
- `uncertain`：结果需要查询；只可核对，不自动重发或直接取消。
- `published`：所选通道返回经过核对且匹配目标账号的真实笔记 URL；内置驱动此时才开放该账号的自动通道。
- `cancelled`：取消未提交的任务。

草稿一旦有活动任务就禁止修改。产品资料变更会撤销未发布草稿的审核状态；发布前再次检查版本，避免使用过期资料。

## 多账号调用方约束

外部桥任务的 `accountId` 来自所选账号映射，不使用全局默认号作为兜底。内置通道也固定目标账号并重新核验当前 Chrome 身份；不匹配时阻塞，不能回退到当前登录的其他账号。首次提交时会冻结外部账号标识，后续 verify 继续使用同一标识，即使账号被暂停。缺少回执 accountId、账号不匹配或没有真实笔记链接时均为待核对。
