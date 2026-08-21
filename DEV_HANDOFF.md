# ERP 开发交接摘要（会话压缩版）

> 生成时间：2026-08-21

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
- 登录账号（中文）：老板 / 采购 / 仓库 / 销售 / 财务 / 工程，密码 88888888（工程=engineer 角色：负责录入成品/零件/BOM；采购只负责供应商维护与零件挂供应商）

## 3. 当前数据状态

- 已清空测试业务数据，仅保留用户账号。
- 已从 Excel 导入真实基础资料：
  - 成品 3：挂档器 CSS-SQ、脚踏板 V3（CSP-V3）、V3I（CSP-V3I）
  - 零件 557
  - 供应商 65
  - BOM 326
- 图片存储：`backend/uploads/`，通过 `/uploads/...` 访问；前端基础资料支持上传。
- 导入脚本：`backend/prisma/import-real-data.ts`，其中 Excel 路径写死为本机微信目录。

## 4. 已完成功能

- 登录/改密，中文账号
- 首页分角色使用说明
- 基础资料：客户/供应商/成品/零件/BOM；零件含规格、图片、图档、模具、MOQ、价格、供应商；新增「工程」角色分工——工程录成品/零件/BOM，采购只挂零件供应商
- 销售订单：新建、状态推进/回退、明细
- 出货：ready 校验、送货单号、签收人、备注、运输节点
- 采购：需求计算、按供应商自动分组生成多张采购单、销售单明细展示、采购单列表
- 仓库：收货（来料单号/QC/不良品）、领料、成品入库、退补货、库存、流水（按物料/按采购单）、收发台账、订单物料计算
- 财务：收付款、订单成本利润、账期
- 看板：应收/应付余额、订单进度
- 图片上传与静态服务

## 5. 还没处理的反馈

> 已全部处理（2026-08-21），详见 FEEDBACK.md 对应条目的“处理”说明：

1. 【中】流水栏查询改为【物料 + 销售订单号】联合查询（原“按采购单查询”移除）；订单+物料一起选时汇总该物料需求/已出库/未出。
2. 【低】大列表已做后端分页（page/pageSize，返回 items/total/totalPages；不传分页参数仍返回全量数组，供下拉框等旧调用使用），前端列表改为服务端分页。

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

当前测试：76 个通过（新增分页/订单流水绑定/工程角色权限测试）。

## 8. 注意事项

- 后端代码变更后需要重启后端；前端 Vite 通常自动热更新。
- 后端测试会向真实 `FEEDBACK.md` 追加“测试反馈”记录，跑完测试需要清理。
- 列表接口分页约定：传 `page`/`pageSize` 返回 `{ items, total, page, pageSize, totalPages }`；不传则返回全量数组（下拉框依赖）。非法分页参数返回 400。
- Git 是便携版：`C:\Users\zhulianghong\Programs\Git\cmd\git.exe`，已加入用户 PATH。
- 上传图片目录已加入 `backend/.gitignore`，不会提交到 Git。

