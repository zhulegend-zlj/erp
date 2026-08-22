import axios from 'axios'

export type Role = 'boss' | 'purchase' | 'warehouse' | 'sales' | 'finance' | 'engineer'

export interface User {
  id: number
  username: string
  name: string
  role: Role
}

// 统一 axios 实例：baseURL 指向后端 API 前缀（开发环境经 Vite 代理转发到 3000）
// 注意：不设置全局 Content-Type——JSON 请求由 axios 默认转换自动带上 application/json，
// 而 FormData 上传需要浏览器自动生成 multipart/form-data + boundary，写死 JSON 会导致
// 后端 multipart 插件报「request is not multipart」
export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
})

// 401 统一处理：登录过期（token 12h）后跳回登录页，避免用户停留在旧页面反复失败。
// 排除 /auth/login（密码错误也是 401）与 /auth/me（启动时恢复登录态，由 auth.tsx 处理）。
api.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error?.response?.status
    const url: string = error?.config?.url ?? ''
    if (status === 401 && !url.includes('/auth/login') && !url.includes('/auth/me')) {
      window.location.assign('/login')
    }
    return Promise.reject(error)
  },
)
