// 列表分页通用助手：
// - 未传 page/pageSize 时返回 { kind: 'none' }，路由保持原有“整页数组”返回（兼容旧调用方，如下拉框全量加载）
// - 传了任一参数则启用分页，返回 { items, total, page, pageSize, totalPages }
// - 参数非法返回 { kind: 'error' }，路由据此返回 400 + 中文提示
export interface PageParams {
  page: number
  pageSize: number
}

export type PaginationParse =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; page: PageParams }

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 200

export function parsePagination(query: Record<string, unknown>): PaginationParse {
  const hasPage = query.page !== undefined && query.page !== ''
  const hasPageSize = query.pageSize !== undefined && query.pageSize !== ''
  if (!hasPage && !hasPageSize) return { kind: 'none' }

  const page = hasPage ? Number(query.page) : 1
  const pageSize = hasPageSize ? Number(query.pageSize) : DEFAULT_PAGE_SIZE
  if (!Number.isInteger(page) || page < 1) {
    return { kind: 'error', message: 'page 必须为正整数' }
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return { kind: 'error', message: 'pageSize 必须为 1-' + MAX_PAGE_SIZE + ' 的整数' }
  }
  return { kind: 'ok', page: { page, pageSize } }
}

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export function pagedResult<T>(items: T[], total: number, page: PageParams): Paged<T> {
  return {
    items,
    total,
    page: page.page,
    pageSize: page.pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / page.pageSize),
  }
}
