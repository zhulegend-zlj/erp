import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // 在任何测试文件（含 import '../db'）加载前把 DATABASE_URL 切到独立测试库，
    // 避免 resetDb() 清空开发库 erp 的业务数据。
    setupFiles: ['src/test/setup-env.ts'],
    // 集成测试共用同一 PostgreSQL 测试库，跨文件并行会互相删数据，改为串行执行
    fileParallelism: false,
  },
})
