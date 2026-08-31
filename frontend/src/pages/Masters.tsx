import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Upload,
  message,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, LinkOutlined, UploadOutlined, DownloadOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'
import { useKeepAliveState } from './keepAlive'
import { notifyError } from './common'
import type { Paged } from './common'
import { CompanyHeadersTab } from './CompanyHeadersTab'

interface CrudField {
  key: string
  label: string
  type?: 'text' | 'textarea' | 'supplier' | 'image' | 'number' | 'drawing'
  required?: boolean
}

interface CrudResource {
  label: string
  path: string
  fields: CrudField[]
}

type CrudRow = { id: number } & Record<string, unknown>

interface SupplierOption {
  id: number
  name: string
}

const DRAWING_ACCEPT = '.pdf,.dwg,.dxf,.step,.stp,.igs,.zip,.xlsx,.jpg,.jpeg,.png,.webp,.gif,.svg'

// 图档上传：pdf/dwg/dxf/step/stp/igs/zip/xlsx 或图片，上传后保存 /uploads 地址
function FileUpload({
  value,
  onChange,
  getContext,
}: {
  value?: string
  onChange?: (v: string | null) => void
  getContext?: () => { partSku?: string; partName?: string }
}) {
  async function customRequest(options: any) {
    const ctx = getContext?.() ?? {}
    if (!ctx.partSku) {
      message.warning('请先填写零件 SKU 再上传图档')
      options.onError?.(new Error('请先填写零件 SKU'))
      return
    }
    const formData = new FormData()
    formData.append('file', options.file)
    formData.append('kind', 'drawing')
    formData.append('partSku', ctx.partSku)
    if (ctx.partName) formData.append('partName', ctx.partName)
    try {
      const { data } = await api.post<{ url: string }>('/uploads', formData)
      onChange?.(data.url)
      options.onSuccess?.(data)
      message.success('图档已上传')
    } catch (err) {
      notifyError(err)
      options.onError?.(err)
    }
  }

  return (
    <div>
      <Upload accept={DRAWING_ACCEPT} maxCount={1} customRequest={customRequest} showUploadList={false}>
        <Button icon={<UploadOutlined />}>{value ? '重新上传图档' : '上传图档'}</Button>
      </Upload>
      {value ? (
        <div style={{ marginTop: 8 }}>
          <a href={value} target="_blank" rel="noreferrer">
            打开已上传图档
          </a>
          <Button
            type="link"
            danger
            size="small"
            style={{ marginLeft: 12 }}
            onClick={() => onChange?.(null)}
          >
            移除
          </Button>
        </div>
      ) : (
        <div style={{ marginTop: 8, color: '#999', fontSize: 12 }}>
          支持 pdf/dwg/dxf/step/stp/igs/zip/xlsx 及图片，单个文件 ≤ 600MB（图片建议 20MB 以内）
        </div>
      )}
    </div>
  )
}

function ImageUpload({
  value,
  onChange,
  getContext,
}: {
  value?: string
  onChange?: (v: string | null) => void
  getContext?: () => { kind?: 'image' | 'product-image'; partSku?: string; partName?: string; productSku?: string; productName?: string }
}) {
  async function customRequest(options: any) {
    const ctx = getContext?.() ?? {}
    if (ctx.kind === 'image' && !ctx.partSku) {
      message.warning('请先填写零件 SKU 再上传图片')
      options.onError?.(new Error('请先填写零件 SKU'))
      return
    }
    if (ctx.kind === 'product-image' && !ctx.productSku) {
      message.warning('请先填写成品 SKU 再上传图片')
      options.onError?.(new Error('请先填写成品 SKU'))
      return
    }
    const formData = new FormData()
    formData.append('file', options.file)
    if (ctx.kind) formData.append('kind', ctx.kind)
    if (ctx.partSku) formData.append('partSku', ctx.partSku)
    if (ctx.partName) formData.append('partName', ctx.partName)
    if (ctx.productSku) formData.append('productSku', ctx.productSku)
    if (ctx.productName) formData.append('productName', ctx.productName)
    try {
      const { data } = await api.post<{ url: string }>('/uploads', formData)
      onChange?.(data.url)
      options.onSuccess?.(data)
    } catch (err) {
      notifyError(err)
      options.onError?.(err)
    }
  }

  return (
    <Upload
      accept="image/*"
      listType="picture-card"
      maxCount={1}
      customRequest={customRequest}
      fileList={
        value
          ? [{ uid: '-1', name: '物料图片', status: 'done' as const, url: value }]
          : []
      }
      onRemove={() => onChange?.(null)}
    >
      {value ? null : (
        <div>
          <PlusOutlined />
          <div style={{ marginTop: 8 }}>上传图片</div>
        </div>
      )}
    </Upload>
  )
}

const RESOURCES: CrudResource[] = [
  {
    label: '客户',
    path: '/customers',
    fields: [
      { key: 'name', label: '名称' },
      { key: 'country', label: '国家' },
      { key: 'contact', label: '联系人' },
      { key: 'address', label: '收货地址', type: 'textarea' },
      { key: 'vatNo', label: 'VAT#', type: 'text' },
      { key: 'eori', label: 'EORI', type: 'text' },
      { key: 'notifyParty', label: '通知方', type: 'textarea' },
      { key: 'defaultPaymentTerms', label: '默认付款条件', type: 'text' },
      { key: 'defaultIncoterm', label: '默认贸易条款', type: 'text' },
      { key: 'defaultMark', label: '默认唛头', type: 'text' },
      { key: 'defaultTaxRate', label: '默认税率', type: 'text' },
    ],
  },
  {
    label: '供应商',
    path: '/suppliers',
    fields: [
      { key: 'name', label: '名称' },
      { key: 'contact', label: '联系人' },
      { key: 'contactPerson', label: '联系人ATTN' },
      { key: 'phone', label: '电话' },
      { key: 'fax', label: '传真' },
      { key: 'email', label: '邮箱' },
      { key: 'defaultPaymentTerms', label: '默认付款方式' },
      { key: 'defaultHeaderName', label: '默认抬头' },
      { key: 'taxPoint', label: '加税点数', type: 'number' },
    ],
  },
  {
    label: '成品',
    path: '/products',
    fields: [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: '名称' },
      { key: 'nameEn', label: '英文品名', type: 'text' },
      { key: 'hsCode', label: '海关编码', type: 'text' },
      { key: 'unit', label: '单位' },
      { key: 'imageUrl', label: '图片', type: 'image' },
    ],
  },
  {
    label: '零件',
    path: '/parts',
    // 列布局按工程 CSP_V3 清单表格口径：去掉 Description-EN、用在何处、生产工艺、序号、用量、单位
    fields: [
      { key: 'sku', label: '料号' },
      { key: 'imageUrl', label: '图片', type: 'image' },
      { key: 'nameEn', label: '英文品名' },
      { key: 'name', label: '中文名称' },
      { key: 'weight', label: '重量(g)' },
      { key: 'revision', label: '版本' },
      { key: 'material', label: '材质' },
      { key: 'dimensions', label: '尺寸规格' },
      { key: 'finish', label: '表面处理' },
      { key: 'drawingsUrl', label: '图档', type: 'drawing' },
      { key: 'moq', label: '起订量', type: 'number' },
      { key: 'leadTime', label: '交货周期' },
      { key: 'safetyStock', label: '安全库存', type: 'number' },
      { key: 'price', label: '价格', type: 'number' },
      { key: 'priceInclTax', label: '含税参考价', type: 'number' },
      { key: 'supplierId', label: '供应商', type: 'supplier' },
    ],
  },
]

function CrudTab({
  resource,
  canWrite,
  linkSupplierOnly,
  omitFields,
  hideFields,
}: {
  resource: CrudResource
  canWrite: boolean
  /** 采购在零件页的特殊模式：只能维护供应商与价格，不能增删改其他字段 */
  linkSupplierOnly?: boolean
  /** 表单中不显示的字段（如工程不填价格） */
  omitFields?: string[]
  /** 列表中不显示的字段（如工程看不到采购价格列） */
  hideFields?: string[]
}) {
  const [rows, setRows] = useState<CrudRow[]>([])
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<CrudRow | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [productId, setProductId] = useState<number | undefined>()
  const [products, setProducts] = useState<Array<{ id: number; sku: string; name: string; bomCount?: number }>>([])
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkingRow, setLinkingRow] = useState<CrudRow | null>(null)
  const [linkSupplierId, setLinkSupplierId] = useState<number | undefined>()
  const [linkPrice, setLinkPrice] = useState<number | null>(null)
  const [linkPriceInclTax, setLinkPriceInclTax] = useState<number | null>(null)
  const [linkSubmitting, setLinkSubmitting] = useState(false)
  const [form] = Form.useForm<Record<string, any>>()
  // 零件页默认每页 100 条、成品页默认 50 条（按老板反馈），其他基础资料页默认 10 条
  const [pageSize, setPageSize] = useState(resource.path === '/parts' ? 100 : resource.path === '/products' ? 50 : 10)
  const isPart = resource.path === '/parts'
  const isProduct = resource.path === '/products'
  // 上传时实时读取表单中的 SKU/名称（避免 useWatch 时序问题导致上下文丢失）
  function uploadContext() {
    const values = form.getFieldsValue(['sku', 'name']) as { sku?: string; name?: string }
    return {
      kind: (isPart ? 'image' : isProduct ? 'product-image' : undefined) as 'image' | 'product-image' | undefined,
      partSku: isPart ? values.sku : undefined,
      partName: isPart ? values.name : undefined,
      productSku: isProduct ? values.sku : undefined,
      productName: isProduct ? values.name : undefined,
    }
  }

  async function load(targetPage = 1, size?: number, searchTerm?: string, prodId?: number) {
    setLoading(true)
    try {
      const ps = size ?? pageSize
      const kw = searchTerm !== undefined ? searchTerm : keyword
      const pid = prodId !== undefined ? prodId : productId
      const params: Record<string, string | number> = { page: targetPage, pageSize: ps }
      if (kw) params.search = kw
      if (pid) params.productId = pid
      const { data } = await api.get<Paged<CrudRow>>(resource.path, {
        params,
      })
      setRows(data.items)
      setTotal(data.total)
      setPage(data.page)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.path])

  useEffect(() => {
    if (resource.path === '/parts') {
      void api
        .get<SupplierOption[]>('/suppliers')
        .then(({ data }) => setSuppliers(data))
        .catch(notifyError)
      void api
        .get<{ id: number; sku: string; name: string }[]>('/products')
        .then(({ data }) => setProducts(data))
        .catch(notifyError)
    }
  }, [resource.path])

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(row: CrudRow) {
    setEditing(row)
    const values: Record<string, any> = {}
    for (const f of resource.fields) {
      const v = row[f.key]
      values[f.key] = v === null || v === undefined ? undefined : v
    }
    form.setFieldsValue(values)
    setModalOpen(true)
  }

  async function handleSubmit(values: Record<string, any>) {
    setSubmitting(true)
    const payload: Record<string, any> = { ...values }
    // 被 omitFields 隐藏的字段即使留在表单 store 里也不提交（如工程的价格/供应商）
    for (const key of omitFields ?? []) delete payload[key]
    for (const f of resource.fields) {
      // 被 omitFields 隐藏的字段（如工程的价格/供应商）不要再注入 payload，
      // 否则会把 price/supplierId 以 null 加回，被后端 'price' in body 校验拒绝
      if (omitFields?.includes(f.key)) continue
      if (f.type === 'supplier' || f.type === 'number') {
        const v = payload[f.key]
        payload[f.key] = v === '' || v === null || v === undefined ? null : Number(v)
      } else if (
        f.type === 'image' ||
        ['spec', 'drawingsUrl', 'tooling', 'nameEn', 'weight', 'revision', 'material', 'dimensions', 'finish', 'artId', 'address', 'vatNo', 'eori', 'notifyParty', 'hsCode', 'defaultPaymentTerms', 'defaultIncoterm', 'defaultMark', 'defaultTaxRate', 'contactPerson', 'phone', 'fax', 'email', 'defaultHeaderName', 'leadTime'].includes(f.key)
      ) {
        if (payload[f.key] === '') payload[f.key] = null
      }
    }
    try {
      if (editing) {
        await api.put(resource.path + '/' + editing.id, payload)
        message.success('已保存')
      } else {
        await api.post(resource.path, payload)
        message.success('已创建')
      }
      setModalOpen(false)
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(row: CrudRow) {
    try {
      await api.delete(resource.path + '/' + row.id)
      message.success('已删除')
      await load()
    } catch (err) {
      notifyError(err)
    }
  }

  function openLink(row: CrudRow) {
    setLinkingRow(row)
    const v = row.supplierId
    setLinkSupplierId(typeof v === 'number' ? v : undefined)
    const p = row.price
    setLinkPrice(p === null || p === undefined || p === '' ? null : Number(p))
    const pit = row.priceInclTax
    setLinkPriceInclTax(pit === null || pit === undefined || pit === '' ? null : Number(pit))
    setLinkOpen(true)
  }

  async function submitLink() {
    if (!linkingRow) return
    setLinkSubmitting(true)
    try {
      await api.put(resource.path + '/' + linkingRow.id, {
        supplierId: linkSupplierId ?? null,
        price: linkPrice ?? null,
        priceInclTax: linkPriceInclTax ?? null,
      })
      message.success('供应商/价格已更新')
      setLinkOpen(false)
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setLinkSubmitting(false)
    }
  }

  const columns = [
    ...resource.fields.filter((f) => !hideFields?.includes(f.key)).map((f) => ({
      title: f.label,
      dataIndex: f.key,
      key: f.key,
      render: (v: unknown) => {
        if (v === null || v === undefined || v === '') return '-'
        if (f.type === 'image') {
          return (
            <Image
              src={String(v)}
              width={64}
              height={64}
              style={{ objectFit: 'contain', background: '#fafafa', border: '1px solid #eee' }}
            />
          )
        }
        if (f.type === 'drawing') {
          return (
            <a href={String(v)} target="_blank" rel="noreferrer">
              打开图档
            </a>
          )
        }
        if (f.type === 'supplier') {
          const supplier = suppliers.find((s) => s.id === Number(v))
          return supplier ? supplier.name : String(v)
        }
        return String(v)
      },
    })),
    ...(linkSupplierOnly
      ? [
          {
            title: '操作',
            key: 'action',
            render: (_: unknown, row: CrudRow) => (
              <Button size="small" icon={<LinkOutlined />} onClick={() => openLink(row)}>
                供应商/价格
              </Button>
            ),
          },
        ]
      : canWrite
        ? [
            {
              title: '操作',
              key: 'action',
              render: (_: unknown, row: CrudRow) => (
                <Space>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Popconfirm title="确认删除？" onConfirm={() => void handleDelete(row)}>
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]
        : []),
  ]

  return (
    <>
      {isPart ? (
        <Space style={{ marginBottom: 16 }} wrap>
          {canWrite ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建{resource.label}
            </Button>
          ) : null}
          <Tag color="blue">共 {total} 个零件</Tag>
          <Select
            allowClear
            showSearch
            placeholder="全部零件（可按成品筛选）"
            style={{ width: 260 }}
            value={productId}
            onChange={(v) => {
              setProductId(v)
              void load(1, undefined, undefined, v)
            }}
            optionFilterProp="label"
            onDropdownVisibleChange={(open) => {
              if (open) {
                void api
                  .get<Array<{ id: number; sku: string; name: string; bomCount?: number }>>('/products')
                  .then(({ data }) => setProducts(data))
                  .catch(() => {})
              }
            }}
            options={products.map((p) => ({
              value: p.id,
              label: p.name + '（' + p.sku + '）' + (p.bomCount != null ? ' · ' + p.bomCount + ' 个零件' : ''),
            }))}
          />
          <Input.Search
            placeholder="按料号/名称/英文品名/供应商/表面处理搜索"
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={(v) => {
              setKeyword(v)
              void load(1, undefined, v)
            }}
            style={{ width: 300 }}
          />
        </Space>
      ) : canWrite ? (
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} style={{ marginBottom: 16 }}>
          新建{resource.label}
        </Button>
      ) : null}
      <Table<CrudRow>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50, 100],
          onChange: (p, s) => {
            if (s !== pageSize) {
              setPageSize(s)
              void load(1, s)
            } else {
              void load(p)
            }
          },
        }}
      />
      <Modal
        title={(editing ? '编辑' : '新建') + resource.label}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          {resource.fields.filter((f) => !omitFields?.includes(f.key)).map((f) => (
            <Form.Item
              key={f.key}
              name={f.key}
              label={f.label}
              rules={
                f.type === 'supplier' ||
                f.type === 'image' ||
                f.type === 'number' ||
                f.type === 'textarea' ||
                ['spec', 'drawingsUrl', 'tooling', 'country', 'contact', 'unit', 'nameEn', 'weight', 'revision', 'material', 'dimensions', 'finish', 'artId', 'address', 'vatNo', 'eori', 'notifyParty', 'hsCode', 'defaultPaymentTerms', 'defaultIncoterm', 'defaultMark', 'defaultTaxRate', 'contactPerson', 'phone', 'fax', 'email', 'defaultHeaderName', 'leadTime'].includes(f.key)
                  ? []
                  : [{ required: true, message: '请输入' + f.label }]
              }
            >
              {f.type === 'supplier' ? (
                <Select
                  allowClear
                  placeholder={'请选择' + f.label}
                  options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                />
              ) : f.type === 'image' ? (
                <ImageUpload getContext={uploadContext} />
              ) : f.type === 'drawing' ? (
                <FileUpload getContext={uploadContext} />
              ) : f.type === 'number' ? (
                f.key === 'moq' ? (
                  <InputNumber min={1} precision={0} step={1} placeholder={'请输入' + f.label} style={{ width: '100%' }} />
                ) : f.key === 'safetyStock' ? (
                  <InputNumber min={0} precision={0} step={1} placeholder={'请输入' + f.label} style={{ width: '100%' }} />
                ) : f.key === 'priceInclTax' ? (
                  <InputNumber min={0} precision={4} placeholder={'请输入' + f.label} style={{ width: '100%' }} />
                ) : f.key === 'taxPoint' ? (
                  <InputNumber min={0} max={100} placeholder={'请输入' + f.label} style={{ width: '100%' }} />
                ) : (
                  <InputNumber min={0} placeholder={'请输入' + f.label} style={{ width: '100%' }} />
                )
              ) : f.type === 'textarea' ? (
                <Input.TextArea rows={2} placeholder={'请输入' + f.label} />
              ) : (
                <Input />
              )}
            </Form.Item>
          ))}
        </Form>
      </Modal>
      <Modal
        title={'供应商/价格：' + (linkingRow ? String(linkingRow.name ?? linkingRow.sku ?? '') : '')}
        open={linkOpen}
        onCancel={() => setLinkOpen(false)}
        onOk={() => void submitLink()}
        confirmLoading={linkSubmitting}
        destroyOnClose
      >
        <div style={{ marginBottom: 8 }}>供应商</div>
        <Select
          allowClear
          showSearch
          placeholder="选择供应商（可清除以取消关联）"
          style={{ width: '100%' }}
          value={linkSupplierId}
          onChange={(v) => setLinkSupplierId(v)}
          optionFilterProp="label"
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
        />
        <div style={{ margin: '12px 0 8px' }}>价格（含税）</div>
        <InputNumber
          min={0}
          precision={4}
          style={{ width: '100%' }}
          placeholder="价格"
          value={linkPrice ?? undefined}
          onChange={(v) => setLinkPrice(typeof v === 'number' ? v : null)}
        />
        <div style={{ margin: '12px 0 8px' }}>含税参考价</div>
        <InputNumber
          min={0}
          precision={4}
          style={{ width: '100%' }}
          placeholder="含税参考价"
          value={linkPriceInclTax ?? undefined}
          onChange={(v) => setLinkPriceInclTax(typeof v === 'number' ? v : null)}
        />
      </Modal>
    </>
  )
}

interface Product {
  id: number
  sku: string
  name: string
  unit: string
  bomCount?: number
}

interface Part {
  id: number
  sku: string
  name: string
  unit: string
  imageUrl?: string | null
}

interface BomItem {
  id: number
  productId: number
  partId: number
  qty: number
  part: { id: number; sku: string; name: string }
}

interface BomRow {
  id?: number
  partId?: number
  qty?: number | null
  partName?: string
  sku?: string
}

function BomTab({ canWrite }: { canWrite: boolean }) {
  const [products, setProducts] = useState<Product[]>([])
  const [parts, setParts] = useState<Part[]>([])
  const [productId, setProductId] = useState<number | undefined>()
  const [rows, setRows] = useState<BomRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  function refreshProducts() {
    void api
      .get<Product[]>('/products')
      .then(({ data }) => setProducts(data))
      .catch(notifyError)
  }

  function refreshParts() {
    void api
      .get<Part[]>('/parts')
      .then(({ data }) => setParts(data))
      .catch(notifyError)
  }

  useEffect(() => {
    refreshProducts()
    refreshParts()
  }, [])

  useEffect(() => {
    if (!productId) {
      setRows([])
      return
    }
    setLoading(true)
    void refreshParts()
    api
      .get<BomItem[]>('/products/' + productId + '/bom')
      .then(({ data }) =>
        setRows(
          data.map((b) => ({
            id: b.id,
            partId: b.partId,
            qty: b.qty,
            partName: b.part.name,
            sku: b.part.sku,
          })),
        ),
      )
      .catch(notifyError)
      .finally(() => setLoading(false))
  }, [productId])

  function updateRow(index: number, patch: Partial<BomRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  async function exportBom() {
    if (!productId) return
    try {
      const res = await api.get('/products/' + productId + '/bom/export', { responseType: 'blob' })
      const cd = (res.headers as Record<string, unknown>)['content-disposition'] as string | undefined
      const m = cd && /filename\*=UTF-8''([^;]+)/.exec(cd)
      const name = m ? decodeURIComponent(m[1] ?? '') : 'erp-BOM.xlsx'
      const url = window.URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (err) {
      notifyError(err)
    }
  }

  async function save() {
    if (!productId) {
      message.warning('请先选择成品')
      return
    }
    // 不完整行不再静默丢弃：提示用户补全或删除
    const incomplete = rows.filter((r) => !r.partId || !r.qty || r.qty <= 0)
    if (incomplete.length > 0) {
      message.warning('有未填完整的行（需选择零件且用量大于 0），请补全或删除后再保存')
      return
    }
    const partIdSet = new Set(rows.map((r) => r.partId))
    if (partIdSet.size !== rows.length) {
      message.warning('BOM 明细中有重复零件，请合并后再保存')
      return
    }
    const items = rows.map((r) => ({ partId: Number(r.partId), qty: Number(r.qty) }))
    setSaving(true)
    try {
      await api.put('/products/' + productId + '/bom', items)
      message.success('BOM 已保存')
      const { data } = await api.get<BomItem[]>('/products/' + productId + '/bom')
      setRows(
        data.map((b) => ({
          id: b.id,
          partId: b.partId,
          qty: b.qty,
          partName: b.part.name,
          sku: b.part.sku,
        })),
      )
    } catch (err) {
      notifyError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="选择成品"
          style={{ width: 300 }}
          value={productId}
          onChange={(v) => setProductId(v)}
          onDropdownVisibleChange={(open) => {
            if (open) void refreshProducts()
          }}
          options={products.map((p) => ({
            value: p.id,
            label: p.name + '（' + p.sku + '）' + (p.bomCount != null ? ' · ' + p.bomCount + ' 个零件' : ''),
          }))}
        />
        {canWrite ? (
          <Button type="primary" onClick={() => void save()} loading={saving} disabled={!productId}>
            保存 BOM
          </Button>
        ) : null}
        <Button
          icon={<DownloadOutlined />}
          disabled={!productId}
          onClick={() => {
            if (productId) void exportBom()
          }}
        >
          导出表格
        </Button>
        {productId ? <Tag color="blue">共 {rows.length} 个零件</Tag> : null}
      </Space>
      {canWrite && productId ? (
        <Space style={{ marginBottom: 8 }}>
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              void refreshParts()
              setRows((prev) => [{}, ...prev])
            }}
          >
            添加零件
          </Button>
        </Space>
      ) : null}
      <Table<BomRow>
        rowKey={(_, i) => String(i ?? 0)}
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          {
            title: '图片',
            key: 'image',
            width: 80,
            render: (_: unknown, r: BomRow) => {
              const url = parts.find((p) => p.id === r.partId)?.imageUrl
              return url ? (
                <Image
                  src={url}
                  width={64}
                  height={64}
                  style={{ objectFit: 'contain', background: '#fafafa', border: '1px solid #eee' }}
                />
              ) : (
                '-'
              )
            },
          },
          {
            title: '零件',
            key: 'partId',
            render: (_: unknown, r: BomRow, index: number) => {
              if (r.id) {
                return <span>{r.partName || r.partId}{r.sku ? '（' + r.sku + '）' : ''}</span>
              }
              return (
                <Select
                  style={{ width: 280 }}
                  placeholder="选择零件（可输入名称/料号搜索）"
                  showSearch
                  optionFilterProp="label"
                  value={r.partId}
                  disabled={!canWrite}
                  onChange={(v) => updateRow(index, { partId: v })}
                  onDropdownVisibleChange={(open) => {
                    if (open) void refreshParts()
                  }}
                  options={parts.map((p) => ({ value: p.id, label: p.name + '（' + p.sku + '）' }))}
                />
              )
            },
          },
          {
            title: '用量',
            key: 'qty',
            render: (_: unknown, r: BomRow, index: number) => (
              <InputNumber
                min={1}
                value={r.qty}
                disabled={!canWrite}
                onChange={(v) => updateRow(index, { qty: v })}
              />
            ),
          },
          ...(canWrite
            ? [
                {
                  title: '操作',
                  key: 'action',
                  render: (_: unknown, _r: BomRow, index: number) => (
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                    >
                      删除
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  )
}

// 公司抬头/银行/VAT 等出单资料：所有角色可看，仅老板可改（发票/装箱单自动带出）
function CompanyProfileTab({ canWrite }: { canWrite: boolean }) {
  const [form] = Form.useForm<Record<string, string>>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void api
      .get<Record<string, string>>('/company-profile')
      .then(({ data }) => form.setFieldsValue(data))
      .catch(notifyError)
  }, [form])

  async function save(values: Record<string, string>) {
    setSaving(true)
    try {
      await api.put('/company-profile', values)
      message.success('公司资料已保存')
    } catch (err) {
      notifyError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Form form={form} layout="vertical" onFinish={save} disabled={!canWrite} style={{ maxWidth: 720 }}>
      <Form.Item name="name" label="公司名称（发票 Issuer/Shipper）">
        <Input placeholder="如 Dongguan Zhiruiheng Electronic Co., Ltd" />
      </Form.Item>
      <Form.Item name="address" label="公司地址">
        <Input.TextArea rows={2} />
      </Form.Item>
      <Form.Item name="contact" label="联系人">
        <Input />
      </Form.Item>
      <Form.Item name="email" label="邮箱">
        <Input />
      </Form.Item>
      <Form.Item name="vatNo" label="VAT 税号">
        <Input />
      </Form.Item>
      <Form.Item name="taxRate" label="税率">
        <Input placeholder="如 0" />
      </Form.Item>
      <Form.Item name="bankName" label="收款银行">
        <Input />
      </Form.Item>
      <Form.Item name="bankPhone" label="银行电话">
        <Input />
      </Form.Item>
      <Form.Item name="bankAddress" label="银行地址">
        <Input.TextArea rows={2} />
      </Form.Item>
      <Form.Item name="swift" label="SWIFT">
        <Input />
      </Form.Item>
      <Form.Item name="accountName" label="账户名">
        <Input />
      </Form.Item>
      <Form.Item name="accountNo" label="账号">
        <Input />
      </Form.Item>
      {canWrite ? (
        <Button type="primary" htmlType="submit" loading={saving}>
          保存
        </Button>
      ) : (
        <p>公司资料由老板/销售维护，其他角色仅可查看。</p>
      )}
    </Form>
  )
}

// 到货仓字典：所有角色可看，销售/老板可增改删
function HubTab({ canWrite }: { canWrite: boolean }) {
  const [hubs, setHubs] = useState<{ id: number; name: string }[]>([])
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null)
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const { data } = await api.get<{ id: number; name: string }[]>('/hubs')
      setHubs(data)
    } catch (err) {
      notifyError(err)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  async function save() {
    if (!name.trim()) {
      message.warning('请输入到货仓名称')
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await api.put('/hubs/' + editing.id, { name: name.trim() })
      } else {
        await api.post('/hubs', { name: name.trim() })
      }
      message.success('已保存')
      setName('')
      setEditing(null)
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: number) {
    try {
      await api.delete('/hubs/' + id)
      message.success('已删除')
      await load()
    } catch (err) {
      notifyError(err)
    }
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 80 },
    { title: '到货仓', dataIndex: 'name', key: 'name' },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'action',
            width: 160,
            render: (_: unknown, r: { id: number; name: string }) => (
              <Space>
                <Button size="small" onClick={() => { setEditing(r); setName(r.name) }}>编辑</Button>
                <Popconfirm title="确认删除？" onConfirm={() => void remove(r.id)}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]
      : []),
  ]

  return (
    <div>
      {canWrite ? (
        <Space style={{ marginBottom: 12 }}>
          <Input
            placeholder="到货仓名称（如 VPC-MEL.）"
            style={{ width: 240 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onPressEnter={() => void save()}
          />
          <Button type="primary" loading={saving} onClick={() => void save()}>
            {editing ? '保存修改' : '新增'}
          </Button>
          {editing ? <Button onClick={() => { setEditing(null); setName('') }}>取消编辑</Button> : null}
        </Space>
      ) : (
        <p>到货仓由销售/老板维护。</p>
      )}
      <Table rowKey="id" columns={columns} dataSource={hubs} pagination={false} size="small" />
    </div>
  )
}

export default function Masters() {
  const { user } = useAuth()
  const role = user?.role
  // 客户：老板 + 采购 + 销售（销售最熟客户）；供应商：老板 + 采购
  const canWriteCustomer = role === 'boss' || role === 'purchase' || role === 'sales'
  const canWriteBusiness = role === 'boss' || role === 'purchase'
  // 零件/BOM：老板 + 工程；成品：老板 + 工程 + 销售（老板要求销售可操作成品）
  const canWriteEngineering = role === 'boss' || role === 'engineer'
  const canWriteProduct = role === 'boss' || role === 'engineer' || role === 'sales'
  // 采购在零件页只挂供应商
  const linkSupplierOnly = role === 'purchase'
  // 保持当前页签：切走再回来仍停在刚才浏览的页签（如零件页）
  const [activeTab, setActiveTab] = useKeepAliveState<string>('masters.activeTab', 'customers')

  return (
    <Card title="基础资料">
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k)}
        items={[
          {
            key: 'customers',
            label: '客户',
            children: <CrudTab resource={RESOURCES[0]!} canWrite={canWriteCustomer} />,
          },
          {
            key: 'suppliers',
            label: '供应商',
            children: <CrudTab resource={RESOURCES[1]!} canWrite={canWriteBusiness} />,
          },
          {
            key: 'products',
            label: '成品',
            children: <CrudTab resource={RESOURCES[2]!} canWrite={canWriteProduct} />,
          },
          {
            key: 'parts',
            label: '零件',
            children: (
              <CrudTab
                resource={RESOURCES[3]!}
                canWrite={canWriteEngineering}
                linkSupplierOnly={linkSupplierOnly}
                omitFields={role === 'engineer' ? ['price', 'priceInclTax', 'supplierId'] : undefined}
                hideFields={role === 'engineer' ? ['price', 'priceInclTax'] : undefined}
              />
            ),
          },
          { key: 'bom', label: 'BOM 维护', children: <BomTab canWrite={canWriteEngineering} /> },
          { key: 'company', label: '公司资料', children: <CompanyProfileTab canWrite={role === 'boss' || role === 'sales'} /> },
          { key: 'companyHeaders', label: '公司抬头', children: <CompanyHeadersTab canWrite={role === 'boss' || role === 'purchase'} /> },
          { key: 'hubs', label: '到货仓', children: <HubTab canWrite={role === 'boss' || role === 'sales'} /> },
        ]}
      />
    </Card>
  )
}
