# HANDOFF.md（已合并，请勿在此更新）

> 本文件原为家里电脑开发时的交接文档，前几节内容已过期（48 测试/5 角色等均为项目初期信息）。
> **唯一的权威交接文档是 [DEV_HANDOFF.md](./DEV_HANDOFF.md)**（持续更新：业务规则、数据状态、机器差异、启动方式、验证命令都在里面）。
> 继续开发前请先读 DEV_HANDOFF.md，再读 FEEDBACK.md 里的待处理反馈。
>
> 简版速查：
> - 本机=工厂电脑 / 家里电脑=另一台：拉代码后先 `npx prisma migrate deploy`，账号用 `npx tsx --env-file=.env prisma/seed.ts` 重建（密码 88888888）
> - 后端 `cd backend && npm run start`（:3000）；前端 `cd frontend && npm run dev -- --host 0.0.0.0`（:5173）
> - 测试 `cd backend && npm run typecheck && npx vitest run`（测试库 erp_test，反馈文件已隔离）；前端 `npm run build`
> - 数据/图片/图档不随 git 同步；导入脚本：`prisma/import-csp-v3*.ts`、`prisma/audit-csp-v3.ts`
