# 开发交接文档（HANDOFF）

> **给工厂电脑上的 dsh / 开发者：** 读完本文档即可无缝接手本项目。这是上一台电脑（家里）完成的工作交接。

## 一、项目是什么

ERP 系统，服务一家**按订单生产（MTO）的组装/贸易企业**。
核心流程：海外客户下订单（成品）→ 按 BOM 拆算零件需求（扣库存、只采购缺口）→ 采购向供应商下单 → 供应商送货、仓管收货 → 生产组长领料（仓管代录）→ 每日打包成品入库（仓管代录）→ 到期出货 → 运输节点跟踪 → 财务对账 → 老板看板。

## 二、当前进度（已全部完成）

- 后端 `backend/`：登录权限（5 角色）+ 8 大模块（基础资料/订单/采购/库存/生产/出货/财务/看板）+ 界面反馈接口
- 前端 `frontend/`：登录 + 7 个业务页面 + 右侧"意见反馈"小按钮（提交到 FEEDBACK.md）
- 部署与备份：`scripts/backup.ps1`、`scripts/deploy.ps1`、`README.md`
- 测试：后端 48/48 通过（vitest），前端 build 通过
- 初始账号密码统一 **88888888**（中文登录账号：老板/采购/仓库/销售/财务，对应角色 boss/purchase/warehouse/sales/finance，上线前必须改）

## 三、继续开发前必读

1. **先读 `FEEDBACK.md`** —— 里面是使用者的真实反馈，按"优先级"从高到低优化；处理完标 `[已处理]` 并说明改动。这是第一优先的待办来源。
2. 设计文档：`docs/superpowers/specs/2026-08-20-erp-design.md`
3. 实施计划：`docs/superpowers/plans/2026-08-20-erp-mvp.md`

## 四、技术栈与运行

- 后端：Node.js 22+ / TypeScript 5.9 / Fastify 5 / Prisma 6 / PostgreSQL 16
- 前端：Vite 5 / React 18 / Ant Design 5 / React Router 6 / axios
- 启动（开发）：后端 `cd backend && npm run start`（端口 3000，读 backend/.env）；前端 `cd frontend && npm run dev`（端口 5173，已配 /api 代理到 3000）
- 测试：`cd backend && npx vitest run`；前端 `cd frontend && npm run build`

## 五、关键约定（重要，接手必知）

1. **测试数据库隔离**：测试连接独立的 `erp_test` 库（见 backend/src/test/setup-env.ts），**不会**清空开发库 `erp`。用户真实数据都在 `erp` 库。切勿让测试再连到 erp。
2. **开发期反馈机制**：用户可在系统界面右侧点"意见反馈"提交，写入项目根 `FEEDBACK.md`；开发前先读它。
3. **初始密码**：88888888（上线前改）。
4. **本地代理**：上一台电脑（家里）通过本地代理 127.0.0.1:7890 访问 GitHub（git 全局已配 http.proxy/https.proxy）。**工厂电脑的网络可能不同**：若 git push/pull 失败，先检查是否需要配置代理（`git config --global http.proxy http://<代理地址>`）或直接能连就无需代理。
5. **GitHub 远程**：`git@github.com:zhulegend-zlj/erp.git`（SSH）或 https 均可，视网络而定。

## 六、当前已知待办（详见 FEEDBACK.md）

- 高：看板金额改"余额"口径（扣已收/已付）
- 高：初始密码上线前改
- 中：输入校验错误应返回 400 而非 500
- 中：缺 GET /api/purchase-orders 采购单列表接口
- 低：出货应校验订单处于 ready；大列表分页
- （可能还有用户新提交的反馈，以 FEEDBACK.md 为准）

## 七、开发技能（Skills）

本次开发使用的 superpowers 技能套件已随项目放在 `.dsh/skills/` 目录（共 14 个：brainstorming、writing-plans、subagent-driven-development、using-git-worktrees、executing-plans、requesting-code-review、receiving-code-review、finishing-a-development-branch、verification-before-completion、systematic-debugging、test-driven-development、using-superpowers、writing-skills、dispatching-parallel-agents）。

工厂电脑若没有这些技能，可直接参考 `.dsh/skills/` 下的技能文件，或把它们复制到本机 `~/.dsh/skills/` 使用。核心几个：**brainstorming**（动手前先做设计）、**writing-plans**（写实施计划）、**subagent-driven-development**（按任务派子代理执行+审查）。

## 八、如何开始

```bash
git pull origin main          # 拉最新代码（若已 clone 则跳过）
# 装依赖
cd backend && npm install && npx prisma generate
cd ../frontend && npm install
# 启动（见第四节）
```

然后**先读 FEEDBACK.md**，从最高优先级反馈开始优化。

## 九、2026-08-23 家里电脑进展（已同步本仓库）

- **手动测试数据**（仅在家里电脑的数据库，见 backend/prisma/test-data-seed.ts 脚本）：
  - 成品 A/B/C（SKU=A/B/C），共 63 个零件（A01-A17、B01-B22、C01-C24，随机价格 0.5-300）
  - 20 个供应商（甲供应商/乙供应商/…/酉供应商），每个零件随机绑定一个供应商
  - BOM 用量随机 1-10；客户留空由用户手填
- **账号清理**：删除了 5 个早期英文测试账号，仅保留 6 个中文账号（老板/采购/仓库/销售/财务/工程，密码统一 88888888）。
- **本轮按用户反馈完成的功能**（详见 FEEDBACK.md 各条 [已处理]）：
  1. 领料出库：采购订单多选（跨多张采购单合并领料、按 partId 去重）、下拉标注供应商、领料人 localStorage 记忆（erp-issue-by）、零件行显示当前库存
  2. QC 补录默认"合格"（ok）
  3. 采购单多选框 maxTagCount="responsive" 标签折叠
  4. 库存查询显示"不良品"列；退补货选物料显示当前库存/不良品
  5. 不良品与退补货实时联动：不良品 = 收货不良 − 累计已退（最小 0）；库存查询新增 已退/已补/应补 三列（应补 = max(0, 已退 − 已补)）
  6. 登记撤销：收货/领料/成品入库/退补货 4 个 DELETE 撤销接口 + 前端各列表"撤销"按钮（仅 warehouse/boss），撤销自动反向回滚库存并留冲销流水（refType=void）
- **测试**：后端 133/133 通过（vitest，测试库 erp_test），前端 build 通过。
- **留存（未处理）**："流水和收发台账会不会有重合功能？"——用户决定先留存，后续再定是否合并。

## 十、工厂电脑下一步（真实数据录入与真实测试）

1. `git pull origin main` 拉最新代码（本轮未改 schema，**无需新迁移**；若 prisma 报错再跑 `npx prisma migrate deploy` 与 `npx prisma generate`）。
2. 启动 PostgreSQL + 后端（3000）+ 前端（5173）。
3. 用"工程"账号（密码 88888888）录入真实数据：先建成品 → 录零件/传图片图档 → 配 BOM → 录供应商（或按 CSP_V3 导入脚本 prisma/import-csp-v3.ts 导入）。
4. 客户由老板/销售录入；随后走真实流程测试：订单 → 采购 → 收货 → 领料 → 成品入库 → 出货 → 财务对账。
5. 使用中遇到的问题：界面右侧"意见反馈"提交，或直接编辑 FEEDBACK.md；dsh 按优先级处理。

> ⚠️ 数据库数据不随 git 同步：家里生成的 A/B/C 测试数据仅在家里电脑的数据库；工厂电脑的数据库是另一份（此前工厂导入的 CSP_V3 数据或空库），真实数据录入在工厂电脑进行，与家里测试数据无关。
