# RedPilot｜薯航

RedPilot（薯航）是小红书产品宣传账号运营平台，目标是把产品资料、灵感收藏、参考分析、图文生成、每日发布与复盘连成一个流程。

这是一个独立项目。当前仓库保存需求、运营方案、示例数据、原创封面样稿以及可运行的封面生成脚本。**尚未实现 Web 应用、截图上传、自动分析服务、小红书账号接入或实际定时发布。**

## 产品需求

- 上传一张或多张笔记截图，或粘贴笔记与账号链接，保存到灵感收藏库。
- 分析参考的选题、标题、封面布局、内容结构与表达方式。
- 结合自有产品资料和素材，生成新标题、正文、话题、封面和内页。
- 支持单篇生成，也支持每日自动从收藏库选择参考、生成并发布。
- 提供全自动与审核后发布两种模式，记录发布结果并避免重复发布。
- 保留产品事实来源与素材缺口，不将参考产品的能力、评价或实测结果直接套用。

完整需求见 [平台需求](docs/platform-requirements.json)。首个产品场景是 SimHelper AI 电话助理。

## 当前内容

| 路径 | 内容 |
| --- | --- |
| `docs/` | 平台需求、产品事实、账号定位、首批选题与文案 |
| `examples/inspirations/` | 本聊天提供的对标账号截图和参考分析样例 |
| `examples/drafts/` | 从参考结构生成的未发布文案及内页分镜示例 |
| `scripts/render_covers.py` | 生成三张 1200 × 1600 封面和一张风格总览图 |
| `design/previews/` | 已检查的封面样稿；示意图不代表实机外观或测试结果 |
| `assets/fonts/` | 脚本使用的两款拉丁字体及对应 SIL Open Font License |

示例数据不是平台自动运行结果，也没有安排任何真实发布任务。

## 运行封面生成脚本

需要 Python 3.10 或以上版本。

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python scripts/render_covers.py
```

默认输出到 `design/previews/`，也可指定输出目录：

```bash
python scripts/render_covers.py --output-dir /absolute/path/to/previews
```

macOS 默认使用系统自带的简体黑体。Linux 默认尝试系统 Noto Sans CJK。其他环境请指定已安装、支持中文的字体：

```bash
python scripts/render_covers.py --cjk-font /absolute/path/to/chinese-font.ttf
```

使用 TTC 字体集合时，可通过 `--cjk-index` 指定字体索引。系统中文字体没有被复制进仓库。

## 后续实现顺序

1. 收藏库的截图上传、链接保存、分类与去重。
2. 可访问内容读取、图片文字识别与参考结构分析。
3. 对接模型和素材生成，并提供可编辑的图文预览。
4. 接入目标小红书账号，配置每日任务和发布结果核对。
5. 补充飞书资料同步、互动数据与内测意向整理。

## 项目边界

项目只在本目录内维护自己的 Git 历史与依赖，不使用其他项目的仓库。运行数据、浏览器登录态、Cookie、环境变量文件和密钥均不纳入版本控制。需求和样例包含内部产品信息，因此仓库默认保持私有。

代码和设计未另行授予开源许可。附带字体按各自的 SIL Open Font License 使用；对标截图仅作为参考资料保存，不属于自有产品素材。
