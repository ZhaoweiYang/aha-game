# 涨薪军师 · 方法论与数据调研

本文整理了产品所依据的谈判方法论、书籍课程和公开数据，以及它们在产品里各自用在什么地方。

## 一、核心方法论

### 1. 哈佛谈判项目：原则式谈判（Principled Negotiation）

出处：《谈判力》Getting to Yes（Roger Fisher、William Ury、Bruce Patton），哈佛法学院谈判项目（Program on Negotiation, PON）

| 原则 | 含义 | 在产品中的落地 |
|---|---|---|
| 人事分开 | 把“人”和“问题”分开处理 | 反驳应对“大家都没涨”：不和同事比，只谈职责与产出 |
| 利益而非立场 | 关注双方真正的诉求，而非表面的“要/不给” | 分析老板的真实顾虑（预算、公平、向上交代） |
| 为双方创造选项 | 不只盯着现金 | Plan B 非现金清单（职级、奖金、期权、书面复议承诺等） |
| 坚持客观标准 | 用外部标准代替讨价还价 | 市场薪资数据、一页纸价值清单 |
| BATNA | 谈判破裂时的最佳替代方案，决定你的底气 | “你的 BATNA”模块；建议谈前先改善 BATNA |

PON 关于锚定的观点：首轮报价会把后续报价拉向它，先报价的一方通常结果更好。

### 2. FBI 谈判技巧：战术同理心（Tactical Empathy）

出处：《掌控谈话》Never Split the Difference（Chris Voss，前 FBI 首席国际人质谈判专家）

| 技巧 | 产品中的用法 |
|---|---|
| 指控审计（Accusation Audit） | 面谈开场先说出老板可能的负面想法 |
| 标注（Labeling） | “听起来这个数字让您有些顾虑” |
| 镜像（Mirroring） | 重复老板最后几个词，引导他多说 |
| 校准问题（Calibrated Questions） | “要实现这个调整，我们需要怎么做？”，用“怎么/什么”而非“为什么” |
| 以“不”为导向的问题 | “如果我下周三再来找您聊，会不会太赶？” |
| “没错”时刻（That’s right） | 收尾时复述共识，直到老板说“没错” |
| 深夜电台语调 | 报数字时放慢、放低、放稳 |
| Ackerman 模型 | 原模型为买方 65%→85%→95%→100% 的递增报价；产品按卖方场景改为“锚点→递减让步→精确数字+非现金收尾”的让步阶梯 |

### 3. 精确锚点

- Mason, Lee, Wiley & Ames（2013），*Precise offers are potent anchors*，Journal of Experimental Social Psychology 49(4)：精确数字报价让对方认为你更了解行情，还价幅度更小。产品中的开价锚点因此取“非整数”。
- 注意：PON 指出相关研究多数以非专业谈判者为对象；报价过于激进也可能伤害关系。因此产品的锚点设在目标之上约 25%，而非无限拉高。
- Galinsky & Mussweiler（2001），*First offers as anchors*，JPSP：先报价的一方更容易获得有利结果。

## 二、书单与课程

| 类型 | 名称 | 作者 / 机构 | 适合解决的问题 |
|---|---|---|---|
| 书 | 《谈判力》Getting to Yes | Fisher、Ury、Patton（哈佛） | 谈判的底层框架 |
| 书 | 《掌控谈话》Never Split the Difference | Chris Voss（前 FBI） | 临场话术与情绪管理 |
| 书 | 《沃顿商学院最受欢迎的谈判课》Getting More | Stuart Diamond（沃顿） | 理解对方、渐进推进 |
| 书 | Negotiation Genius | Malhotra、Bazerman（哈佛商学院） | 锚定、ZOPA、保留价格 |
| 书 | Getting Past No | William Ury | 应对强硬、拖延 |
| 书 | 《关键对话》Crucial Conversations | Kerry Patterson 等 | 高压对话 |
| 书 | Ask for It / Women Don’t Ask | Linda Babcock（CMU） | 不开口的代价 |
| 书 | Fearless Salary Negotiation | Josh Doody | 薪资谈判专项 |
| 课程 | Program on Negotiation | 哈佛法学院 | BATNA、锚定专题报告，高管谈判课 |
| 课程 | Successful Negotiation: Essential Strategies and Skills | 密歇根大学 George Siedel（Coursera） | 结构化准备：目标、底线、替代方案 |
| 课程 | Introduction to Negotiation | 耶鲁大学 Barry Nalebuff（Coursera） | 原则式、有说服力的谈判 |
| 课程 | Chris Voss Teaches the Art of Negotiation | MasterClass | FBI 技巧演练 |

## 三、数据基准

| 数据 | 数值 | 用途 |
|---|---|---|
| PayScale《Raise Anatomy》（2018，约 16 万人） | 主动要求加薪的人中 70% 获得了涨薪，其中 39% 拿到了所要求的幅度，31% 拿到的比要求的少 | 成功率模型基准；付费页数据不足时的社会证明 |
| 前程无忧《2026 离职与调薪调研报告》 | 2025 年企业整体调薪 4.1%（2024 年 4.3%），42.8% 的企业实施调薪；高科技 4.9%、医药 4.4%、制造 4.3%、汽车 4.1%、金融 3.0%；预计 2026 年 4.0% | 涨幅模型的行业基线（`js/schema.js` 中的 `INDUSTRY_BASE`） |
| 光辉国际（Korn Ferry） | 预测 2026 年中国调薪率 4.3%；一级晋升调薪 5.0%，二级 7.7% | 参考 |

## 四、模型说明

### 成功率

逻辑回归形式：`p = sigmoid(Z0 + Σ 因素)`，因素包括绩效、成果数量与是否量化、不可替代程度、薪资与市场对比、外部 offer、公司经营状况与类型、审批权限、与老板关系、上次调薪时间、司龄、调薪窗口、期望是否过高、是否同时谈升职。

- “直接开口”成功率：按用户当前状态计算，上限 88%。
- “按方案执行后”成功率：把可控因素（成果量化、市场调研、时机选择、期望校准、沟通准备）调到优化状态后重新计算，提升最多计 15 个百分点，上限 93%。
- “成功”定义为谈话后 3 个月内获得任何幅度的涨薪。

### 涨幅

以行业调薪基线为起点，叠加绩效、市场差距、成果、不可替代程度、上次调薪时间、外部机会、升职诉求，再乘以公司经营状况、企业类型、薪资带宽系数。有外部 offer 且愿意离开时，中位数至少为 offer 溢价的 75%。区间为中位数的 0.55–1.4 倍。

### 局限

模型权重基于公开研究的方向性结论与经验设定，不是用本产品用户数据训练得出的。上线后建议用 `/api/outcome` 收集到的真实结果定期回归校准权重。

## 参考链接

- [PayScale Raise Anatomy](https://www.payscale.com/data/how-to-ask-for-a-raise)
- [Harvard PON：锚定](https://www.pon.harvard.edu/tag/anchoring-negotiation/)
- [Harvard PON：BATNA](https://www.pon.harvard.edu/freemium/batna-basics-boost-your-power-at-the-bargaining-table)
- [Harvard PON：精确报价](https://www.pon.harvard.edu/daily/dealmaking-daily/forming-first-offers-take-precision-account-nb/)
- [Mason et al. 2013 预印本](https://drupalgsb-test.paas.cc.columbia.edu/sites/default/files-efs/pubfiles/5957/precise_offers.pdf)
- [前程无忧 2026 离职与调薪调研报告（新京报报道）](https://m.bjnews.com.cn/detail/1769484325129195.html)
- [Coursera：Successful Negotiation](https://www.coursera.org/learn/negotiation-skills)
