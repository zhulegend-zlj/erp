import axios from 'axios'

export type Role = 'boss' | 'purchase' | 'warehouse' | 'sales' | 'finance'

export interface User {
  id: number
  username: string
  name: string
  role: Role
}

// 统一 axios 实例：baseURL 指向后端 API 前缀（开发环境经 Vite 代理转发到 3000）
export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
})
