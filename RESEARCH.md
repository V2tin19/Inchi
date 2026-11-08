# 竞品与先行者调研（2026-11-07）

> 调研问题：网上有没有已经做出来的成品，做了理序要做的事？
> 结论先说：**单品零件全都有人做过，完整组合没人做过。** 最近的三个近亲是 Pikko（中文）、Energy-Based Routine（海外）、Amazing Marvin 的 Energy 策略；理序独有的部分是「断点续传闭环 + 光谱条 + 低谷缓冲 + 零惩罚红线 + 对话式录入」这一整套，以及自托管、自带模型钥匙的形态。

## 一、直接同类：状态 / 精力驱动的任务工具

| 产品 | 平台 / 价格 | 机制 | 与理序的距离 |
|---|---|---|---|
| **Pikko** | iOS，免费，中文 | 自研精力算法（作息 + 心率 + 运动）算出当前精力值 CEL，主屏直接给「现在适合做的任务」；定位「精力优先，不是时间优先」，明确反对清单越记越多带来的心理负担 | **最近的近亲**。差异：它是自动推断精力（要读你的身体数据），理序是自我报告；它是封闭成品，理序是对话式 + 自托管；它没有断点续传与光谱条 |
| **Energy-Based Routine** | iOS / Android，免费，17 种语言 | 给每个任务标精力档位，打开就只显示与当前精力匹配的任务 | 机制上几乎就是理序的路由器最小版。看起来是独立开发者的轻量实现，无留档、无指标、无低谷缓冲——像一个「没长完的理序」 |
| **精力快充** | 中文 App | 任务设精力类型与强度，自动匹配高能时段 | 方向相同但逻辑相反：它是「找高能时段装任务」，理序是「先报状态再发牌」 |
| **Lifestack** | lifestack.ai | 读可穿戴设备的睡眠 / 健康数据，AI 按精力峰谷排日程 | 是「自动排期器」路线，本质仍是日历优先，且依赖硬件数据 |
| **Amazing Marvin** | 全平台，订阅 | 内置 Energy 策略与 Energy Levels 模板：任务标精力值，按当前状态筛选分组；还有 This or That 帮你在两件事间做选择 | ADHD 社区口碑最好且最可定制的通用工具。但它是「可配置的瑞士军刀」，状态路由只是其中一个策略；无留档覆写、无低谷缓冲。官方博客也提醒：精力标签容易过度使用 |

## 二、部分重叠的单品（按理序的机制逐个对照）

| 理序的机制 | 已经有人做的 | 值得借鉴 / 注意 |
|---|---|---|
| 单任务聚光灯 | Llama Life（一次只显示一个任务，ADHD 社区常用）；Tiimo / Structured 的可视化日程 | Llama Life 验证了「单卡片降低过载」有效；但它靠**倒计时** timebox——正是理序红线里不要的东西，用户口碑好与坏参半，可引以为鉴 |
| 第一步动作（点火） | Goblin.tools 的 Magic ToDo：AI 把吓人的大任务拆成小步并估时 | 验证了「拆小到能上手」是 ADHD 工具的头号刚需。理序第一步动作靠人写、AI 辅助提议，可以在对话层借鉴 Goblin 的拆法 |
| 断点续传（nextStep 覆写 firstStep） | **没有找到任何成品做这件事** | 最接近的只有任务拆解（面向未来）和日记类应用（面向过去），「给下次的自己留指针并自动覆写」是理序独有 |
| 正向计时 | 部分专注 App 有正向模式，但 ADHD 主流产品（Llama Life、Routinery）几乎全用倒计时 | 理序的「只正向」在市场上是少数派立场，恰好是差异点 |
| 光谱条（分类构成、非评判） | 时间统计类（Toggl、 RescueTime）有分类报表；待办类没有这种「只呈现构成、不打分」的主指标形态 | 属于理序的呈现层独创 |
| 低谷缓冲（自动调低目标、无断更耻感) | 几乎没有。主流产品反其道而行：连续打卡、streak、火焰图标 | Finch 等自我关怀类 App 有「无惩罚」精神，但不做任务路由。理序的反 streak 立场是明确空位 |
| 对话式录入 | Saner.ai（ADHD 向 AI 笔记 + 任务）、PlanCoach（AI 拆任务，2025 年罗永浩公开 ADHD 后受关注）、Fabric | 验证了对话/AI 录入方向成立，但都是独立 SaaS，与状态路由不沾边 |
| 能量预算 | 奶油小众圈「Spoon 理论」工具：Spoons – Energy Tracker、Spoonie Day（慢性病人群按能量预算过日子） | 人群不同（慢性病 vs 状态起伏），但「能量是预算、任务是支出」的心智模型同源，可翻它们的交互找灵感 |

## 三、方法论与社区实践（比产品更早的源头）

- **GTD 的精力维度**：David Allen 体系之外，社区长期流行给 next action 加「精力标签」（低电量清单、5 分钟清单）。OmniFocus 论坛上有人踩过的坑值得抄在墙上：**低电量清单会变成永远逃避硬任务的借口**——理序的对策恰好内建：雷达永远可见 + 光谱条让「连续几天全是松石绿没有深海蓝」的事实自己说话，不需要弹窗说教。
- **能量映射（Energy Mapping）**：ADHD 社区在 Notion / 纸上手工做「状态 × 时段」矩阵再人肉匹配任务，说明需求真实存在，只是没有顺手的工具承接。

## 四、中文市场与命名

- **Pikko** 是中文市场里离理序最近的产品（见第一节），值得装机实测一次。
- **命名撞车提醒**：已有多平台时间管理 App「**时光序**」（花生未来广州，日程 / 待办 / 纪念日，v4.21）。「理序」与它字面有区分度，应用商店搜索时不会被吞，但对外介绍时建议主动说清区别。英文名已定为 `Cairn`。

## 五、定位建议（调研的落点）

1. **放心做。** 路由器的零件各处都有验证（ Marvin 验证精力标签、Llama Life 验证单卡片、Goblin 验证拆步骤、Pikko 验证状态优先），没有任何成品把它们与「断点续传 + 非评判指标 + 低谷缓冲 + 对话录入」装在一起，也没有人走「自托管 + 自带钥匙」的形态。
2. **抄作业清单**：Goblin.tools 的拆步话术（进对话层）；Marvin 的 This or That（聚光灯换牌的备选交互）；Pikko 的 CEL 想法反过来用——不自动推断，但在足迹页里让用户回看「状态 × 时段」的自证规律（与习惯画像天然合流）。
3. **避坑清单**：低电量清单变逃避借口（雷达 + 光谱条已内建对策，别再加任何「平衡建议」弹窗）；精力标签过度工程（三档封顶，不再细分成十档）；倒计时 timebox（红线，不做）。
4. **建议下一步**：装机实测 Pikko 与 Energy-Based Routine 各半小时，把「用着最烦的一刻」记进 RESEARCH 附录——最好的差异化线索往往在近亲最烦人的地方。

## 来源

- [Energy-Based Routine（App Store）](https://apps.apple.com/us/app/energy-based-routine/id6745750243) / [Google Play](https://play.google.com/store/apps/details?id=com.TortillaCake.energyBasedRoutines)
- [Lifestack](https://lifestack.ai) · [Lifestack：SkedPal 替代品对比（2026-06）](https://lifestack.ai/blog/skedpal-alternatives)
- [Amazing Marvin：Energy 策略帮助文档](https://help.amazingmarvin.com) · [不靠计划与排期的做法（官方博客）](https://amazingmarvin.com/blog/dm-how-can-i-be-productive-without-planning-or-scheduling) · [This or That 策略](https://help.amazingmarvin.com/amazing-marvin/this-or-that) · [ADHD 用户的 Marvin 实践](https://focusedwithadhd.com)
- [Llama Life](https://llamalife.co)（2026 年多份 ADHD 应用榜单收录）
- [GTD 论坛：低精力状态怎么办](https://forum.gettingthingsdone.com/threads/for-low-energy-states.5461) · [Todoist 的 GTD 指南](https://www.todoist.com/productivity-methods/getting-things-done)
- [Routinery 博客：任务瘫痪应用盘点](https://routinery.app) · [ADD.org 2026 ADHD 应用榜单](https://add.org) · [habi.app：Structured 对比](https://habi.app)
- [Morgen：SkedPal 替代品（2026-01）](https://www.morgen.so/blog-posts/skedpal-alternatives) · [Reddit：五类日程规划应用](https://www.reddit.com/r/ProductivityApps/comments/1t59dx1/i_think_there_are_5_types_of_daily_planning_apps)
- [Spoons – Energy Tracker（App Store）](https://apps.apple.com/ng/app/spoons-energy-tracker/id6757321413)
- [时光序（App Store）](https://apps.apple.com/us/app/id1343731648)
- Pikko：《一个专为「P 人」和 ADHD 设计的精力管理 App》（搜狐，2026-10）及其 App Store 页面
- Tiimo / Inflow / Goblin.tools / Neurolist / Saner.ai / PlanCoach：见 2026 年各 ADHD 应用榜单与虎嗅报道
