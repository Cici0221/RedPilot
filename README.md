# RedPilot｜薯航

自用小红书内容运营工作台。独立仓库，公开托管。

## 启动

需要 **Node.js 22.18+**，无 npm 运行依赖。首次使用先在本机配置登录账号：

```bash
npm run auth:configure
```

按提示输入登录邮箱和密码，密码不回显。再启动服务：

```bash
npm start
```

打开 **http://localhost:4317**。开发时运行 `npm run dev`。修改端口可在 `.env` 中设置 `PORT`。

## 当前可用

- 平台登录：固定单用户邮箱与密码、8小时会话、退出登录、服务端保护全部业务接口和素材。
- 蓝白简约界面：总览、收藏、创作、图片、发布排期、账号管理、产品资料、设置。
- 多账号：官方号与普通号、默认账号、独立启停/每日设置、归档保留历史。
- 草稿和任务绑定账号，发布前固定外部账号 ID；回执必须匹配同一账号。
- 截图分组上传、链接与正文收藏；按笔记 ID、图片 SHA-256 合并重复资料。
- 收藏标签、选题池、参考详情和删除。
- 产品事实、限制和来源编辑；修改资料后提示重新核对旧稿。
- 产品素材库：图标、产品图片、宣传册、模型上传与已有本地模型引用，真实预览与下载、SHA-256 去重。
- STEP 模型按标准、正面、侧角渲染，生成 1200 × 1600 PNG 自动回存素材库。
- 文字稿与图文稿分别生成、编辑、审核与排期；本地事实模板可离线使用。
- 文字稿预览与导出文案，发布端使用小红书原生默认配图；该发布能力尚待实机验证。
- 图文稿直接预览和导出所选原图；图标另附在 ZIP 的 sources/。分镜为可选策划，不自动生成文字卡。
- 草稿核对、未来时间排期、任务取消、运行日志。
- 每日生成调度、发布桥接口、幂等键、结果待核对与禁止盲目重试。
- 本机 JSON 持久化与数据快照导出。

## 需要配置的功能

复制 `.env.example` 为 `.env`，填写配置后重启。密钥不通过网页下发。

| 功能 | 配置与边界 |
| --- | --- |
| AI 截图分析、参考改写 | 设置 `REDPILOT_AI_KEY`、`REDPILOT_AI_MODEL`，可选 `REDPILOT_AI_BASE_URL`。使用支持图片与 JSON mode 的 Chat Completions 接口；仅在用户操作或启用每日任务时调用。配置服务会收到所选截图、参考文字和产品资料。 |
| 图片生成、参考图编辑 | 设置 `REDPILOT_IMAGE_API_KEY`，可选图片服务地址和模型。独立于文字 AI 配置，详见下方图片工作台配置；未配置时显示未启用。 |
| 实际小红书发布 | **尚无内置发布驱动或账号登录功能**。需部署并配置兼容 [发布桥协议](docs/publishing-bridge.md) 的服务。未接通时保留排期，显示待处理；不会真的发布。 |
| 每日任务 | 每账号设置时间、IANA 时区、自动/审核模式与图文比例，默认图文70%/文字30%，各账号默认关闭，每天一次。按成功生成数均匀轮换，失败与手动生成不占比；改变比例重新计数，保留历史。服务关闭或电脑休眠时不执行，不补往日内容。 |
| 飞书资料 | 当前为此前已读取资料的手动快照和来源链接，**尚无自动同步**。 |
| 链接读取 | 当前只保存链接；**尚无网页抓取/登录读取器**。补充截图或粘贴正文后可分析，不能仅凭 URL 生成网页阅读结论。 |

未配置 AI 时可使用本地事实模板。模板不会识别截图、执行自由改写或迁移参考风格，页面会明确标注。AI 分析输出经过格式校验，仍需核对事实；基础检查不是完整的宣传事实审核。

各账号的自动模式会选择共享选题池中使用次数较少的参考，生成内容，通过基础检查后交给发布桥。生成失败或资料缺失时记录原因；当前未实现多候选逐个回退和语义去重，仅检查该账号的重复标题。审核模式只生成草稿，人工核对后自行安排发布时间。

## 图片工作台配置

在本机 `.env` 中配置后重启服务：

```dotenv
REDPILOT_IMAGE_API_KEY=
REDPILOT_IMAGE_BASE_URL=https://api.openai.com/v1
REDPILOT_IMAGE_MODEL=gpt-image-2.5-sunburst
```

`REDPILOT_IMAGE_API_KEY` 留空时仅接受 `OPENAI_API_KEY` 作为后备，不会借用文字接口的 `REDPILOT_AI_KEY`。图片密钥只留在服务端；状态接口仅返回是否已配置与模型名称。默认模型依据当前 [OpenAI 图片指南](https://developers.openai.com/api/docs/guides/image-generation) 与 [编辑 API](https://developers.openai.com/api/reference/resources/images/methods/edit) 选择，可自行改为兼容图片 API 的模型。

纯文字生成调用 `/images/generations`；参考图编辑调用 `/images/edits`，仅发送当前选中的 1 至 4 张 PNG、JPEG 或 WebP 图片及本次要求，不会把 SVG、宣传册或模型文件直接发送给图片服务。提示词最多 4000 字符，支持 1024 × 1024、1024 × 1536、1536 × 1024，每次生成一张图。请求有 3 分钟超时，返回图片上限 20MB，校验编码和图片格式；只接收返回的 `b64_json`，不下载服务返回的远程 URL。自定义服务需要支持这两类端点和 base64 结果。未配置密钥时不发起请求；自动化测试使用模拟结果，没有执行付费图片调用。

## 平台登录

未登录访问工作台会跳转登录页；所有业务接口、图片、PDF、模型、上传截图和参考资料均要求有效会话。登录页、登录脚本、公共CSS/字体和只读会话状态为公开入口。没有账号自助注册或远程初始化功能，未完成本机配置时也无法匿名进入。

账号配置保存在忽略的 `runtime/auth.json`，密码仅保留随机盐与 scrypt 哈希，文件权限0600；真实邮箱密码不会写入前端、示例或公开仓库。Cookie 为随机会话标识，设置 HttpOnly、SameSite=Strict，8小时后失效；退出或重启服务也会失效。登录有同源检查和每IP最近15分钟5次尝试限制，成功登录会清除失败记录。

要重设账号，在本机重新运行 `npm run auth:configure` 并重启服务。自动化配置可使用 `node scripts/configure-auth.mjs --json-stdin` 从隐藏的标准输入接收 `{email,password}`；不要把密码写进命令行参数。平台登录账号只用于本工作台，和小红书账号登录分别管理。

认证实现使用 [Node.js Crypto](https://nodejs.org/api/crypto.html)；Cookie 属性参照 [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)。

## 产品素材与3D渲染

进入“产品资料 → 素材库”查看和上传素材。图片、SVG 图标与 PDF 保存在本机 `runtime/product-assets/files/`；PDF 提取文字和首页预览（系统需有 Poppler 的 pdfinfo、pdftotext、pdftoppm，缺失时仍保存原件）。文件内容只作为资料，不执行其中指令，也不会把宣传册里的承诺自动写进产品事实。

3D 模型支持在页面上传单个 STEP/STP、STL、GLB、OBJ 或 BLEND 文件，单文件最多 1GB。上传采用二进制流，校验后保存到本机 `runtime/product-assets/files/`，之后不依赖原文件路径。暂不支持 `.gltf` 上传或自动收集模型的外部依赖。当前仅 STEP/STP 可以按标准、正面、侧角渲染产品图，其余格式保存为模型素材，可下载，暂不能直接渲染。

已有的本地模型引用继续保留，仍只记录绝对路径、摘要和说明；源文件移动或改变后会提示重新关联，不会自动复制大文件。如果主动上传的文件与已有引用的 SHA-256 相同，会将原素材转为本机托管，保留素材 ID 与已有预览，之后不再依赖旧路径。上传不会修改或删除用户原文件。

渲染任务完成后将 PNG 入库，失败原因会保留。STEP 首次转换生成可复用网格缓存，后续渲染更快；缓存不额外复制 STEP 原件，同一模型不会并发重复渲染。

CAD 渲染可选依赖见 `requirements-render.txt`，当前工作站已安装，无需重复安装。可指定 `REDPILOT_PYTHON` 选择 Python 环境：

```bash
python3 app/render_product.py --probe
python3 app/render_product.py --model /absolute/path/product.step --output /absolute/path/product.png --preset studio --cache-dir /absolute/path/cache
```

生成图使用源模型几何与示意材质，不能代替实机或功能测试。图文稿可选择原图、裁切保存图、CAD 渲染图或 AI 图片；配置文字 AI 后，选中的产品图片会连同参考一起输入模型。默认选最近两张产品图片，显式取消则不自动补图。图文审核及排期至少需要一张 kind=image 主图，SVG 图标仅作来源。文字稿不带自有图片。发布桥收到的 `post.images` 与预览及 ZIP 主图一致，按选择顺序排列，无需再次合成文字卡。

所有真实素材、上传模型、模型引用路径、渲染缓存和生成图片均保留在忽略的 `runtime/` 中，不上传公开代码仓库。备份整个 `runtime/` 会包含已上传模型；仍为本地引用的模型需要另外备份原文件，迁移后重新关联新路径。

## 多账号

在“账号管理”添加账号，填写昵称、类型、账号标识、主页和备注。每个账号的定位备注会用于 AI 创作。产品资料与灵感共享，草稿、排期和发布记录按账号区分。

`bridgeAccountId` 是发布桥里实际账号的 ID；仅添加记录或填写 ID 不等于已经登录。登录态由发布桥按账号隔离保存，本工作台不收集密码或 Cookie。

已有数据首次升级时迁入默认“官方账号”，保留草稿、任务和每日设置。`REDPILOT_ACCOUNT_ID` 只在这次迁移时填写旧默认账号的映射，新号必须在页面单独配置。未配置的新号不会回退到官方号发布。

暂停账号会阻止新的发布；历史结果仍可核对。归档前需要取消或核对未完成任务，并先将默认账号改为其他账号。归档保留数据。存在排期或提交历史的账号不允许换成另一个外部发布 ID，以免旧任务串号。

## 数据与运行方式

- 默认仅监听 `127.0.0.1`，只供本机单人使用，平台登录为单用户，和管理的多个小红书账号分开。不要直接反向代理成公网服务。
- `runtime/state.json` 保存资料、收藏、草稿、排期和最近 200 条运行记录；`runtime/uploads/` 保存截图，`runtime/product-assets/` 保存产品素材、PDF预览、网格缓存和渲染结果。
- 原子写入、串行更新与进程锁保护本机数据。运行一个实例；启动时会把中断的发布标记为待核对。
- 备份整个 `runtime/` 可保留图片和内容。页面导出的 JSON 快照不含图片文件，当前无页面恢复入口。
- `.env`、运行数据、Cookie、登录态、密钥均忽略，不随公开代码上传。

## 检查

```bash
npm run check
npm test
```

接口测试覆盖持久化、输入检查、去重、版本失效、排期竞争、每日运行、AI 请求格式、发布幂等与结果核对，以及素材导入/文件校验/路径隔离/异步模型渲染、登录保护/会话失效/频控。外部 AI 和发布器使用测试替身；不代表已验证真实账号发布。

## 目录

| 路径 | 内容 |
| --- | --- |
| `app/` | Node HTTP 服务、本机存储、生成与发布调度 |
| `public/` | 原生 JavaScript / CSS 网页，无前端构建步骤 |
| `test/` | Node 原生接口测试 |
| `docs/` | 需求、产品资料、运营方案、发布桥协议 |
| `examples/` | 明确标注的参考与编辑样例 |
| `design/previews/` | 早期深色封面样稿，保留作设计历史；当前网页模板为蓝白 |
| `scripts/render_covers.py` | 早期封面生成脚本 |

封面脚本需要 Python 3.10+ 与 `requirements.txt` 中的 Pillow。运行 `python scripts/render_covers.py --help` 查看中文字体及输出设置。

AI 接口依据 [OpenAI Chat Completions 文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)和[图片输入文档](https://developers.openai.com/api/docs/guides/images-vision)实现。代码和设计未另行授予开源许可。字体按随附 SIL Open Font License 使用；对标截图仅作参考，不属于自有产品素材。
