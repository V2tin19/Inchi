# 理序 · Cairn

> **“理其绪，序其时。”**  
> 对话驱动的时间块规划、弹性任务管理与自律习惯学习智能体。  
> 采用 Anthropic / Claude 风格的温暖人文美学设计（暖亚麻、陶土红高亮、沉静微浮雕与优雅排印）。

> v2 状态路由重构已定稿：设计规范见 [SPEC.md](SPEC.md)，分期路线见 [ROADMAP.md](ROADMAP.md)。本文档其余部分描述 v1 现状。

---

## 一、为什么是「理序」？

传统 Todo 的本质是**一张不断堆积的死清单（Deadlines & Lists）**，随着未完成项增多，带给人的只有内疚与认知过载。

而理序（Cairn）重构了时间管理模型：
1. **说人话记录**：输入框不是填表格，而是像跟搭子聊天。说“今天下午学了2小时数据结构”，代码级 NLU 自动精准抽取用时与科目。
2. **卡片防误确认**：所有重要写入都先呈现交互卡片（落库 / 撤销 / 改写），猜错零成本，服务端全链路撤销栈兜底。
3. **确定性自动排期（Time-Boxing）**：不靠死板的固定闹钟。说“今天学408两小时”，排期引擎根据你的作息（起床/就寝边界）自动切成 $\le$90 分钟的专注块并插入 10 分钟呼吸留白。
4. **习惯画像自聚合（Habit Learning）**：每晚自动聚合你的真实作息（中位数起床就寝时间、高频科目时段偏好），让排期自适应你的生理脉搏。
5. **主动通知总线（Web + QQ）**：支持网页右上角微光铃铛与基于 NapCat 的独立 QQ 推送器（晨报、午间巡检、晚间催日志、周报）。
6. **自定义 AI 接口（网页直配）**：设置弹窗里直接填 Base URL / API Key / 模型名，支持服务商预设、一键拉取模型列表、粘贴自动清洗（整段 JSON 配置也能识别）、连接测试与配置复制，保存即时生效，不用改 `.env` 不用重启。

---

## 二、视觉与设计哲学

- **Claude / Anthropic 调色板**：暖亚麻纸张底色（`#FAF9F5`）、陶土红核心强调色（`#C96442`）、深茶暖炭正文字（`#23221E`）与柔和卡片投影。
- **对话流即桌面**：中央单列流式阅读，兼顾移动端与大屏，无多余侧边栏干扰。
- **轻量气泡聚焦看板（Focus Cadence）**：实时展示今日专注投入度、当前/下一个时间块、以及本周弹性任务胶囊进度条。

---

## 三、目录架构

```
Cairn/
├── index.html              # 主界面（v1 暖色三视图 → v2 暗色遥测工作台）
├── style.css               # 暖色系人文设计系统
├── app.js                  # 前端核心状态控制器
├── dev-server.mjs          # 本地极速自研开发服务器（内建 D1 内存假库）
├── package.json
├── schema.sql              # Cloudflare D1 数据库结构
├── ROADMAP.md              # 演进规划
│
├── functions/              # Cloudflare Pages Functions（智能体大脑）
│   └── api/
│       ├── _llm.js         # OpenAI 兼容客户端（带空内容重试、大预算自适应）
│       ├── _shared.js      # 鉴权与通用工具
│       ├── agent/          # 智能体核心引擎
│       │   ├── _agent.js   # 意图分发、正则快车道、卡片状态机、撤销栈
│       │   ├── _nlu.js     # 日期与时长解析纪律（47 项用例移植）
│       │   ├── _scheduler.js # 确定性日排期引擎（切块、避让、偏好窗）
│       │   ├── _logs.js    # 量化日报（代码硬算指标 + LLM 拓展）
│       │   ├── _outbox.js  # 统一通知队列
│       │   └── _stats.js   # 统计与健康分评估
│       └── admin/agent/    # REST API 路由
│           ├── chat.js     # 对话入口 (/api/admin/agent/chat)
│           ├── tasks.js    # 弹性任务 CRUD (/api/admin/agent/tasks)
│           ├── schedule.js # 排期应用与时段预览
│           ├── logs.js     # 量化日志
│           ├── profile.js  # 习惯画像与偏好
│           ├── learn.js    # 夜间画像聚合
│           ├── outbox.js   # 站内通知
│           └── cron/       # 定时触发端点 ([kind].js)
│
├── pusher/                 # QQ 消息推送守护进程（Python）
│   ├── pusher.py           # aiohttp 轮询 outbox + 定时触发 cron
│   ├── config.example.json
│   └── README.md
│
└── tests/                  # 全套自动化离线测试
    ├── agent/
    │   ├── _nlu.test.mjs       # 47 项严格日期/同义词解析断言
    │   └── _scheduler.test.mjs # 排期算法边界与切块断言
    └── _cairn.test.mjs         # 大脑全链路集成断言（无需 LLM Key）
```

---

## 四、快速开始

### 1. 本地极速体验

无需任何外部依赖或配置：

```bash
# 运行单元测试
npm test

# 启动本地开发服务器
npm run dev
```

浏览器打开 `http://localhost:8792` 即可直接体验：
- 尝试输入：*“今天下午学了2小时数据结构”*，体验卡片生成与确认；
- 尝试输入：*“今天学408两小时”*，体验时间块排期；
- 尝试输入：*“撤销”*，体验一键时间回滚。

### 2. 部署到 Cloudflare Pages

1. 在 Cloudflare 创建 Pages 项目，绑定此仓库；
2. 绑定 D1 数据库，变量命名为 `DB`，执行 `schema.sql`；
3. 配置环境变量：
   - `ADMIN_TOKEN`: 你的专属密钥暗号；
   - `LLM_API_KEY`: 大模型 API Key（可选，未配置时自动进入纯规则引擎与模板降级模式）；
   - `LLM_BASE_URL`: OpenAI 兼容接口地址；
   - `LLM_MODEL`: 模型名称（如 `deepseek-chat`）。

   > 💡 也可以完全不动环境变量：启动后在网页右上角「⚙️ 设置 → 自定义 AI 接口」里填好
   > Base URL / API Key / 模型并保存，即刻生效。网页配置的优先级高于 `.env`；
   > 清除网页配置后自动回落到 `.env`。

---

## 五、开源协议

MIT License (c) 2026 Cairn Authors.
