# PetCheck 提交清单（对照官方规则）

依据 2026-10-20 抓取的 [官方规则](https://amazonappdev2026.devpost.com/rules)。截止：**北京时间 10-24 03:00**（10-23 12:00 PT），建议 10-23 上午提交。评审期 11-09 至 11-20，在此期间线上项目必须保持可免费测试。

英文提交材料草稿都在本目录，需要学生逐份通读并改成自己的表述后再填到 Devpost：

| 文件 | 对应 Devpost 字段 |
|---|---|
| [description.md](description.md) | 项目描述（About the project）、Built with |
| [testing-instructions.md](testing-instructions.md) | Testing instructions（部署后填入 URL 和 household key） |
| [product-feedback.md](product-feedback.md) | Product feedback（含 AWS Builder 服务说明）、可选的 Feature requests |
| [video-script.md](video-script.md) | 视频分镜；旁白文本在 `scripts/make-narration-polly.sh` |

## 硬性要求

| 官方要求 | 状态 | 证据或待办 |
|---|---|---|
| 自托管 MCP server，spec ≥ 2025-11-25，Streamable HTTP | ✅ | 协商结果为 `2025-11-25`；`npm run check:mcp`（官方 MCP Inspector CLI 2.9.0）全部通过 |
| 仓库在运行时真实调用赛道技术（不能只在 README 提及） | ✅ | `src/mcp.ts` `McpServer`、`src/lambda.ts` 传输层入口、`src/assistant.ts` MCP Client 每轮都经 HTTP 调用 `/mcp` |
| 模拟 Alexa+ 的源码在仓库中，视频清楚展示其运行 | ✅ | `src/alexa.html`、`src/assistant.ts`、`src/models.ts`；视频由 `scripts/video/` 用真实应用录制 |
| 仓库含全部源码、素材、清晰的安装运行说明 | ✅ | 干净目录按 README 复现：`npm install` → `npm test` → `npm run build` → `npm run demo` 全部成功 |
| 公开仓库带开源许可证，且在 About 区可见 | ✅（需确认） | MIT `LICENSE`；GitHub API 识别为 MIT。提交前在仓库页面确认 About 区显示 |
| 文字描述说明功能 | 草稿 ✅ | description.md |
| 视频 < 3 分钟，YouTube/Vimeo 公开，英文 | 已生成，待上传 | `scripts/video/make-video.mjs` 用 AI 生成：AI 旁白（逐段转写校验）+ Playwright 录制真实应用 + ffmpeg 剪辑；上传需学生的 YouTube 账号 |
| 视频不含第三方商标、无授权音乐 | ✅ | 录制用 `?video=1`，引擎显示为 "AI model"，页脚和幻灯片不出现厂商名；无音乐；结尾卡片注明配音为 AI 生成、数据为样例 |
| 每个工具/API/SDK 的产品反馈（5 个问题） | 草稿 ✅ | product-feedback.md，"Again?" 等主观项由学生确认 |
| 声明赛道 Alexa+、小挑战 AWS Builder | 待填表 | AWS 服务说明写在产品反馈里（规则要求） |
| 评委可测试至评审期结束；私有站点需提供凭据 | 待部署 | 用户已决定先只做本地开发；正式提交前需部署，并在 testing-instructions.md 填入 URL 和 key |
| 赛期内新建或大幅更新 | ✅ | 首次提交 2026-09-29，晚于提交期开始日 2026-08-31 |
| 第三方 API 须按其条款获授权使用 | 待确认 | 模型 key 由教师稍后更换；提交前确认新 key 的条款允许线上应用调用 |
| 所有材料为英文 | ✅ | 仓库内的中文文档是教学用的，不属于提交材料；如需要，提交前可移出仓库 |
| Friction log（可选，最多加 10%） | ✅ | `FRICTION_LOG.md` 共 8 条，字段齐全，均为学生当时的真实记录 |

## 验收场景

| 场景 | 结果 | 证据 |
|---|---|---|
| 12 个 Agent 场景（真实模型） | ✅ | `npm run test:live`（固定演示时钟、服务端会话）：Claude Opus 5.5、Claude Haiku 5.5、GPT-4.1 mini（中转站）和 Qwen 3.8 Max（阿里云）均 12/12 |
| 多轮对话（服务端会话） | ✅ | 跟进追问、跨轮代词、同一设备上 Dad 和 Emma 交替说话的重复确认；`test:assistant` 验证第 2 轮能看到第 1 轮的工具调用和结果 |
| 数据存储 | ✅ | `STORAGE=file` 本地持久化（只追加的 JSONL，重启后读回），会话同样持久化；DynamoDB 增加照护网络分区和会话（IAM 已加 GetItem）；`test:storage` 覆盖跨容器和文件存储 |
| 照护网络（发布需求 / 智能接单） | ✅ | 发布：AI 整理成固定表单、自动定位、读回确认后发布；接单：按距离、服务、宠物种类、日期、报酬筛选并排除时间冲突，先到先得；`test:market`（草稿、拒绝规则、自动定位、筛选、冲突、接单、通知）+ 真实模型场景 |
| 实际语音输入 | 部分 ✅ | 浏览器端用模拟识别器跑通：识别结果 → 真实模型 → MCP → 家庭页面一致（含 "Machi" 识别错误的纠正）。真人麦克风仍需学生在 Chrome/Safari 实测一次 |
| 自动提醒（无需点按钮） | ✅（本地） | 本地服务内置每 5 分钟检查（`CHECK_EVERY_MIN`）；`test:alerts` 验证定时运行、去重、补记后显示已解决 |
| 主人邮件 | 逻辑 ✅ / 真实发送待部署 | `test:alerts` 验证哪些提醒会发邮件、主题和内容；SNS 实发需部署后看收件箱 |
| 兽医预约提醒 | ✅ | 前一天 9:00 起提醒一次，页面显示并邮件通知 |
| 另一位同学按 README 独立运行 | ✅（模拟） | 干净目录复现通过，含 `.env.example` → `npm run demo:ai` 的真实模型路径 |
| 用户试用（3–5 户） | ❌ 未开展 | 需要学生找真实家庭，不能用样例数据代替 |

## 提交前学生必须亲自做的事

1. 读懂 10-20 的全部改动（见这次 PR 的说明），能讲清模型协议适配层和 MCP 的分工。规则要求作品是参赛者自己的成果，可以接受技术协助，但思路和成果要归参赛者。
2. 部署：在 `.env.deploy` 里加入模型配置，执行 `npm run deploy`，然后运行 `API_KEY=<key> npm run check:mcp -- <URL>/mcp`。
3. 完整看一遍 `scripts/video/out/petcheck-demo.mp4`（不入库，在教师电脑上），确认没问题后用自己的账号上传到 YouTube（公开）。也可以按 video-script.md 自己重新生成。
4. 通读 description.md 和 product-feedback.md，改成自己的话；补上 "What we learned" 和 DynamoDB 的反馈。
5. 填写 Devpost 表单，并保存提交成功的截图。
