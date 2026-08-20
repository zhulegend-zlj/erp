import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // 集成测试共用同一 PostgreSQL，跨文件并行会互相删数据，改为串行执行
    fileParallelism: false,
  },
})
