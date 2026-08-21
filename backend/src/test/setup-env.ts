// 必须在任何 import prisma 的模块加载前执行（由 vitest setupFiles 保证），
// 让测试使用独立的 erp_test 数据库，避免污染开发库 erp。
process.env.DATABASE_URL = 'postgresql://postgres@localhost:5432/erp_test'
process.env.JWT_SECRET = 'test-secret'
