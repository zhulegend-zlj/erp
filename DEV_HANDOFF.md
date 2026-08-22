# ERP 开发交接摘要（工厂 → 家里，最新）

> 生成时间：2026-08-21（工厂电脑会话结束前更新，已全部提交并推送到 GitHub main）
>
> **本会话（工厂电脑）完成的工作**：工程角色与权限分工、大列表分页、流水联合查询、采购页白屏修复、BOM 图片/新行置顶/列序、图档文件上传（pdf/dwg 等）、零件按 SKU 前缀+数值排序、测试 60→84。
>
> **在家里继续开发**：直接 `git pull origin main` 后按第 6 节启动；首次记得 `npx prisma migrate deploy`（engineer 枚举迁移）与重建账号（见第 3 节）。

## 1. 项目是什么

MTO（按单组装/贸易）ERP：销售订单 → BOM 需求 → 采购 → 收货 → 领料/成品入库 → 出货 → 财务 → 老板看板。

仓库实际业务参考了微信目录下的 8 个 Excel（成品出货、挂档器/杂项/脚板物料表、物料入出库、物料退补货）。

## 2. 项目位置与访问

- 代码目录：`D:\AI\erp`
- GitHub：https://github.com/zhulegend-zlj/erp.git（main）
- 后端：http://127.0.0.1:3000
- 前端：http://127.0.0.1:5173
- 局域网：http://192.168.1.114:5173（需防火墙放行 3000/5173）
- 数据库：PostgreSQL 16，127.0.0.1:5432，库 `erp` / `erp_test`
- PostgreSQL 便携版：`D:\AI\pg-dist\pgsql`，数据目录 `D:\AI\pg-data`
- 登录账号（中文）：老板 / 采购 / 仓库 / 销售 / 财务 / 工程，密码 88888888（工程=engineer 角色：负责录入成品/零件/BOM，不填价格；采购负责供应商维护、零件挂供应商、填价格）
- 工厂局域网访问需放行 3000/5173（脚本已入库：`scripts/allow-lan-firewall.ps1`，管理员 PowerShell 运行）

## 3. 当前数据状态

- 已清空测试业务数据，仅保留用户账号；已新增「工程」账号（工厂 dev 库内已创建，id=6）。
- 已从 Excel 导入真实基础资料：
  - 成品 3：挂档器 CSS-SQ、脚踏板 V3（CSP-V3）、V3I（CSP-V3I）
  - 零件 557
  - 供应商 65
  - BOM 326
- **待办数据**：P1927-DAPM 新机型的三张采购单（PO-DS-0217A/C/D，供应商晨鑫/铭亚/合丰磁铁）里的零件尚未录入——按分工由「工程」账号在基础资料录入零件（编号用采购单固有编号如 P1927-14872，不填价格），「采购」负责挂供应商、填价格。
- **数据恢复记录**：2026-08-22 开发时曾误用测试清库脚本清空过开发库，已通过 `npx tsx --env-file=.env prisma/import-real-data.ts` 从微信目录 Excel 全量重导（成品 3 / 零件 557 / 供应商 65 / BOM 326，记录 id 已重新生成）；业务数据（订单/采购单/库存/出货/财务）为空，需重新走流程测试。
- 图片/图档存储：`backend/uploads/`（已 gitignore），通过 `/uploads/...` 访问；零件图片与图档（pdf/dwg/dxf/step/stp/igs/zip/xlsx，≤20MB）均可上传。
- 导入脚本：`backend/prisma/import-real-data.ts`，其中 Excel 路径写死为本机微信目录。
- **家里数据库迁移**：家里库若缺 `engineer` 枚举值，跑 `cd backend && npx prisma migrate deploy`；6 个账号可用 `npx tsx --env-file=.env prisma/seed.ts` 重建（注意：会把所有账号密码重置回 88888888）。

## 4. 已完成功能

- 登录/改密，中文账号
- 首页分角色使用说明
- 基础资料：客户/供应商/成品/零件/BOM；零件含规格、图片、图档（支持上传 pdf/dwg/dxf/step/stp/igs/zip/xlsx 等，≤20MB）、模具、MOQ、价格、供应商；新增「工程」角色分工——工程录成品/零件/BOM，采购只挂零件供应商
- 销售订单：新建、状态推进/回退、明细
- 出货：ready 校验、送货单号、签收人、备注、运输节点
- 采购：需求计算、按供应商自动分组生成多张采购单、销售单明细展示、采购单列表
- 仓库：收货（来料单号/QC/不良品）、领料、成品入库、退补货、库存、流水（物料 + 销售订单号联合查询，汇总需求/已出库/未出）、收发台账、订单物料计算
- 大列表分页：订单/库存/流水/收发台账/采购单/出货单/退补货/基础资料，后端 page/pageSize + 前端服务端分页
- 零件列表排序：按 SKU 字母前缀分组（同产品族）+ 组内数字升序，全站零件下拉统一
- 上传：图片（jpg/png/webp/gif/svg）+ 图档（pdf/dwg/dxf/step/stp/igs/zip/xlsx），单个 ≤20MB
- 财务：收付款、订单成本利润、账期
- 看板：应收/应付余额、订单进度
- 图片上传与静态服务

## 5. 反馈处理情况

> 全部反馈已处理（含本会话新提交的），详见 FEEDBACK.md 各条目的“处理”说明。本会话处理过的：采购页选订单白屏（订单接口缺客户信息）、工程登录基础资料无权限（Vite dev 服务过期缓存，已重启）、BOM 显示零件图片/新行置顶/图片列左移、零件排序、图档上传。
>
> 未处理：无（截至 2026-08-21）。

## 6. 启动 / 重启方式

后端：
```powershell
cd D:\AI\erp\backend
npm run start
```

前端：
```powershell
cd D:\AI\erp\frontend
npm run dev -- --host 0.0.0.0
```

数据库启动（如未运行）：
```powershell
D:\AI\pg-dist\pgsql\bin\pg_ctl.exe -D D:\AI\pg-data -l D:\AI\pg-data\pg.log -o "-p 5432" start
```

## 7. 验证命令

```powershell
cd D:\AI\erp\backend
npm run typecheck
npm test

cd D:\AI\erp\frontend
npm run build
```

当前测试：84 个通过（新增分页/订单流水绑定/工程角色权限/图档上传/零件排序测试）。

## 8. 注意事项

- 后端代码变更后需要重启后端；前端 Vite 通常自动热更新，但**偶发服务端转换缓存过期**（页面权限/UI 与磁盘代码不一致）——现象是“改了没生效”，处理：重启前端 dev 服务 + 浏览器 Ctrl+F5 硬刷新。
- 后端测试会向真实 `FEEDBACK.md` 追加“测试反馈”记录，跑完测试需要清理。
- **测试清库防呆**：`src/test/helpers.ts` 的 `resetDb()` 已加保护——仅当 `DATABASE_URL` 含 `erp_test` 时才允许清库，误连开发库会直接抛错，不会再清空真实数据。
- 列表接口分页约定：传 `page`/`pageSize` 返回 `{ items, total, page, pageSize, totalPages }`；不传则返回全量数组（下拉框依赖）。非法分页参数返回 400。
- 上传接口 `/api/uploads`：按扩展名白名单校验（图片额外校验 MIME），最大 20MB（server.ts multipart limits）。
- 零件排序在 PostgreSQL 层（masters.ts 零件分支）：SKU 前缀分组 + 数字段 bigint[] 升序；修改时注意 regexp_matches 是集合函数，必须用 `array_agg` 子查询，否则行会被复制。
- Git 是便携版：`C:\Users\zhulianghong\Programs\Git\cmd\git.exe`，已加入用户 PATH；本机直连 GitHub 无需代理（家里的机器如失败，检查 `git config --global http.proxy`）。
- 上传文件目录 `backend/uploads/` 已 gitignore（根 .gitignore 同时忽略 `*.log`、`node_modules/`、`dist/`）。

