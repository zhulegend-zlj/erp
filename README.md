# ERP 系统部署文档

本项目为 MTO（按单组装/贸易）ERP 系统，前后端分离：

- 后端 `backend/`：Node.js >= 22 + TypeScript + Fastify，入口 `backend/src/server.ts`，默认监听 **3000** 端口，API 前缀 `/api`。
- 前端 `frontend/`：React + Vite + Ant Design，构建产物 `frontend/dist/`。
- 数据库：PostgreSQL 16，数据库名 `erp`。

---

## 1. 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 22 | 后端 `engines` 要求 `>=22` |
| npm | 随 Node 安装 | 建议 10+ |
| PostgreSQL | 16 | 标准安装版或便携版均可 |
| pg_dump | 随 PostgreSQL | 用于每日备份 |

---

## 2. 安装 Node.js 22+

1. 到 <https://nodejs.org/> 下载 LTS（22.x）Windows 安装包，一路下一步安装。
2. 打开新的 PowerShell，验证：

```powershell
node --version   # 应显示 v22.x
npm --version
```

---

## 3. 安装并启动 PostgreSQL 16

### 3.1 标准安装

1. 到 <https://www.postgresql.org/download/windows/> 下载 PostgreSQL 16 安装包。
2. 安装时记住 **superuser 密码**（默认用户 `postgres`）。
3. 安装完成后确认服务已启动：

```powershell
Get-Service postgresql*   # 应显示 Running
```

### 3.2 设置 PostgreSQL 服务开机自启（可选但推荐）

```powershell
Set-Service -Name postgresql-x64-16 -StartupType Automatic
```

> 服务名可能不同（如 `postgresql-x64-16`），先用 `Get-Service postgresql*` 确认实际名称。

### 3.3 创建数据库 erp

```powershell
# 方式一：用 psql（标准安装路径，按实际调整）
& 'C:\Program Files\PostgreSQL\16\bin\psql.exe' -U postgres -c "CREATE DATABASE erp;"

# 方式二：用 createdb
& 'C:\Program Files\PostgreSQL\16\bin\createdb.exe' -U postgres erp
```

若数据库已存在会报错，可先检查：

```powershell
& 'C:\Program Files\PostgreSQL\16\bin\psql.exe' -U postgres -c "\l"
```

---

## 4. 配置 backend/.env

在 `backend/` 目录下创建 `.env` 文件（示例见 `backend/.env`，可复制后修改）：

```dotenv
DATABASE_URL="postgresql://postgres:你的密码@localhost:5432/erp"
JWT_SECRET="请改成一段足够长的随机字符串"
PORT=3000
```

- `DATABASE_URL`：连接串，`postgresql://用户名:密码@主机:端口/数据库`。本机免密/trust 场景可省略密码（如 `postgresql://postgres@localhost:5432/erp`）。
- `JWT_SECRET`：登录 token 的签名密钥，**上线前必须改掉默认值**。
- `PORT`：后端监听端口，默认 3000，可不写。

> 后端通过 `npm run start`（即 `tsx --env-file=.env src/server.ts`）读取该文件；Prisma CLI 也会自动读取 `backend/.env`。请勿提交含真实密码的 `.env` 到 git。

---

## 5. 安装依赖

```powershell
cd backend
npm install

cd ..\frontend
npm install
```

> 国内网络慢可在 npm 安装前配置镜像：`npm config set registry https://registry.npmmirror.com`。

---

## 6. 数据库迁移

```powershell
cd backend
npx prisma migrate deploy
npx prisma generate
```

> 首次部署执行 `migrate deploy` 会应用 `backend/prisma/migrations` 下的迁移，建出全部表和 `Role` 枚举。

---

## 7. 一键部署脚本

```powershell
cd D:\zhule\Documents\erp   # 项目根，按实际路径替换
.\scripts\deploy.ps1
```

脚本会依次执行：

1. 前端 `npm install` + `npm run build`（产物 `frontend/dist/`）
2. 后端 `npm install` + `npx prisma migrate deploy` + `npx prisma generate`
3. 输出启动命令与说明

可选参数：`-SkipFrontend`（跳过前端）、`-SkipBackend`（跳过后端）。

> 若 PowerShell 阻止运行脚本，先执行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。

---

## 8. 启动系统

### 8.1 启动后端（监听 3000）

```powershell
cd backend
npm run start
```

看到 `Server listening at http://0.0.0.0:3000` 即启动成功。健康检查：<http://127.0.0.1:3000/api/health>。

### 8.2 托管前端（frontend/dist）

前端构建产物是纯静态文件，接口统一走 `/api`。三种方式：

**方式 A：npx serve（第一版 / 本机简单方式）**

```powershell
cd frontend
npx serve -s dist -l 5173
```

浏览器访问 <http://localhost:5173>。

> ⚠️ 注意：`npx serve` 只提供静态文件、**不代理接口**，因此仅用它时前端 `/api` 请求无法到达后端。联调请用「方式 C 开发服务器」（已内置代理），或「方式 B 反向代理」。

**方式 B：Nginx 反向代理（生产推荐）**

把 `frontend/dist` 作为静态站点，并将 `/api` 转发到后端：

```nginx
server {
  listen 5173;
  root D:/zhule/Documents/erp/frontend/dist;
  index index.html;

  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
  }

  location / {
    try_files $uri $uri/ /index.html;   # SPA 路由回退
  }
}
```

**方式 C：开发服务器（仅联调用）**

```powershell
cd frontend
npm run dev
```

Vite 开发服务器已配置 `/api` 代理到 `127.0.0.1:3000`（见 `frontend/vite.config.ts`）。

---

## 9. 创建初始账号（5 个角色）

系统登录账号（中文用户名）：`老板`、`采购`、`仓库`、`销售`、`财务`，对应角色分别为 boss / purchase / warehouse / sales / finance。

以下命令用 `backend/prisma/seed.ts` 一次性创建/更新 5 个角色用户（初始密码统一 `88888888`）：

```powershell
cd backend
npx tsx --env-file=.env prisma/seed.ts
```

> 🔒 系统右上角提供「修改密码」入口（POST /api/auth/change-password），各角色登录后可自行修改初始密码；如需重置，可修改 `prisma/seed.ts` 中的密码后重跑该命令。

---

## 10. Windows 开机自启（schtasks 示例）

让后端在开机时自动启动（按实际路径替换，在**管理员 PowerShell** 中执行）：

```powershell
$action = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-Location ''D:\zhule\Documents\erp\backend''; npm run start"'
schtasks /Create /F /TN "ERP-Backend" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $action
```

说明：

- 任务名 `ERP-Backend`，开机（`ONSTART`）运行，以 SYSTEM 账户执行。
- 后端日志可重定向：把 `npm run start` 换成 `npm run start *>> D:\erp-backups\backend.log`（需先建目录）。
- 查看/删除：`schtasks /Query /TN "ERP-Backend"`、`schtasks /Delete /TN "ERP-Backend" /F`。
- 若 SYSTEM 账户的 PATH 找不到 npm，请把 `npm` 换成完整路径，例如 `C:\Program Files\nodejs\npm.cmd`。

前端如需开机自启，可仿照创建一条任务指向 `npx serve` 或 Nginx 服务。

---

## 11. 每日备份计划任务（schtasks 示例）

用 Windows 计划任务每天 **02:00** 执行 `scripts/backup.ps1`（备份到 `D:\erp-backups\`，保留最近 30 份）：

```powershell
$action = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\zhule\Documents\erp\scripts\backup.ps1"'
schtasks /Create /F /TN "ERP-Backup" /SC DAILY /ST 02:00 /RU SYSTEM /RL HIGHEST /TR $action
```

### 11.1 让 pg_dump 免密执行

计划任务无人值守，pg_dump 不能弹密码提示（脚本已加 `-w`）。请二选一：

1. **本机 trust 免密**：编辑 PostgreSQL 的 `pg_hba.conf`，把 `127.0.0.1/32` 与 `::1/128` 的认证方式改为 `trust`，然后重启 PostgreSQL 服务（单机 ERP 常用做法）。
2. **设置 PGPASSWORD 环境变量**（机器级，对 SYSTEM 账户生效）：

   ```powershell
   [Environment]::SetEnvironmentVariable('PGPASSWORD', '你的postgres密码', 'Machine')
   ```

   也可改用 `%APPDATA%\postgresql\pgpass.conf`（内容 `localhost:5432:erp:postgres:密码`）。

### 11.2 验证

```powershell
.\scripts\backup.ps1                       # 手动备份一次
Get-ChildItem D:\erp-backups\erp-*.sql      # 应看到 erp-YYYYMMDD-HHMMSS.sql
Get-Content D:\erp-backups\backup.log -Tail 20
```

> pg_dump 路径可参数化：默认探测常见安装路径，也可用 `-PgBin "D:\pg16"` 或环境变量 `$env:PGBIN` 指定 bin 目录。

---

## 12. 故障排查

### 端口 3000 被占用

```powershell
netstat -ano | findstr :3000          # 找到占用进程 PID
taskkill /PID <PID> /F                # 结束该进程（谨慎确认）
```

后端启动报 `EADDRINUSE` 即端口冲突；也可改 `backend/.env` 的 `PORT` 换端口（前端代理/nginx 需同步改）。

### 数据库未启动 / 连接失败

```powershell
Get-Service postgresql*                # 应 Running，否则：
Start-Service postgresql-x64-16
```

后端报 `P1001: Can't reach database server` 或 `ECONNREFUSED`：确认 PostgreSQL 已启动、`DATABASE_URL` 主机端口正确、密码正确。

### 登录报 401「用户名或密码错误」

- 确认已按第 9 节创建初始账号。
- 确认 `backend/.env` 的 `JWT_SECRET` 与启动时一致（改密/重启后旧 cookie 失效属正常，重新登录即可）。

### pg_dump 找不到

```powershell
.\scripts\backup.ps1 -PgBin "D:\pg16"    # 或 "C:\Program Files\PostgreSQL\16"
```

### npm install 慢或失败

```powershell
npm config set registry https://registry.npmmirror.com
npm cache clean --force
```

### PowerShell 拒绝执行脚本

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

---

## 13. 安全提醒

- 上线前务必：改掉 `JWT_SECRET`、改掉初始账号 `88888888` 密码、移除任何测试账号。
- `backend/.env`、备份 SQL 含敏感数据，勿提交到公开仓库、勿放在共享目录。
- `D:\erp-backups\` 建议定期异地拷贝（脚本只做本地轮转，不做异地容灾）。
