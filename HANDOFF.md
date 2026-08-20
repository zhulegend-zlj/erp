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
- 初始账号密码统一 **88888888**（5 角色：boss/purchase/warehouse/sales/finance，上线前必须改）

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
