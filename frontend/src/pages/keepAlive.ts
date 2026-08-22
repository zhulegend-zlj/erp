import { useEffect, useState } from 'react'

// 会话级状态缓存：组件卸载后值仍保留在模块内存中，重新挂载时恢复。
// 用于「切换页面回来继续操作」场景（如采购页正在生成的采购单明细）。
const store = new Map<string, unknown>()

export function useKeepAliveState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => (store.has(key) ? (store.get(key) as T) : initial))
  useEffect(() => {
    store.set(key, value)
  }, [key, value])
  return [value, setValue] as const
}
