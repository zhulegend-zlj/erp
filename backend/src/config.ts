export interface Config {
  databaseUrl: string
  jwtSecret: string
  port: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL
  const jwtSecret = env.JWT_SECRET
  const rawPort = env.PORT ?? '3000'
  const port = Number(rawPort)

  if (!databaseUrl) {
    throw new Error('环境变量 DATABASE_URL 未设置')
  }
  if (!jwtSecret) {
    throw new Error('环境变量 JWT_SECRET 未设置')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`环境变量 PORT 必须是 1-65535 的整数，当前值: "${rawPort}"`)
  }

  return { databaseUrl, jwtSecret, port }
}

export const config = loadConfig()
