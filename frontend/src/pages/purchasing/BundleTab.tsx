import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  message,
} from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { api } from '../../api'
import { notifyError, money } from '../common'
import type { Supplier } from './types'

interface Bundle {
  id: number
  supplierId: number
  supplierName: string
  name: string
  totalPrice: number
  note?: string | null
  items: {
    partId: number
    sku: string
    partName: string
    qty: number
    unitPrice: number | null
    allocatedPrice: number | null
  }[]
}

interface BomPart {
  id: number
  partId: number
  qty: number
  part: { id: number; sku: string; name: string; sourcing: string; missingPrice: boolean; supplierId: number | null }
}

interface ItemField {
  partId: number
  sku: string
  partName: string
  qty: number
  unitPrice?: number | null
}

function allocate(items: ItemField[], totalPrice: number): Map<number, number> {
  const map = new Map<number, number>()
  const overrideCost = items.reduce((s, it) => s + (it.unitPrice != null ? it.unitPrice * it.qty : 0), 0)
  const remaining = Math.max(0, totalPrice - overrideCost)
  const restQty = items.reduce((s, it) => s + (it.unitPrice == null ? it.qty : 0), 0)
  const unit = restQty > 0 ? remaining / restQty : 0
  for (const it of items) map.set(it.partId, Math.round((it.unitPrice != null ? it.unitPrice : unit) * 10000) / 10000)
  return map
}

export default function BundleTab(props: { canCreate: boolean; suppliers: Supplier[] }) {
  const { canCreate, suppliers } = props
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Bundle | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()
  const [products, setProducts] = useState<{ id: number; sku: string; name: string }[]>([])

  useEffect(() => {
    api
      .get<{ id: number; sku: string; name: string }[]>('/products')
      .then((r) => setProducts(r.data))
      .catch(() => {})
  }, [])

  async function load() {
    setLoading(true)
    try {
      const r = await api.get<Bundle[]>('/price-bundles')
      setBundles(r.data)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }
  function openEdit(b: Bundle) {
    setEditing(b)
    form.setFieldsValue({
      supplierId: b.supplierId,
      name: b.name,
      totalPrice: b.totalPrice,
      note: b.note ?? undefined,
      productId: undefined,
      items: b.items.map((it) => ({
        partId: it.partId,
        sku: it.sku,
        partName: it.partName,
        qty: it.qty,
        unitPrice: it.unitPrice ?? undefined,
      })),
    })
    setModalOpen(true)
  }

  // 候选 BOM 零件（选成品后加载）
  const [bomParts, setBomParts] = useState<BomPart[]>([])

  // 选供应商后：BOM 零件里属于该供应商的自动跟着选入套餐
  const watchedSupplierId = Form.useWatch('supplierId', form) as number | undefined
  function autoAddSupplierParts(bps: BomPart[], supId: number | undefined) {
    if (!supId) return
    const cur: ItemField[] = (form.getFieldValue('items') as ItemField[] | undefined) ?? []
    const have = new Set(cur.filter((x) => x?.partId != null).map((x) => x.partId))
    const add: ItemField[] = bps
      .filter((bp) => bp.part.supplierId === supId && !have.has(bp.partId))
      .map((bp) => ({ partId: bp.partId, sku: bp.part.sku, partName: bp.part.name, qty: bp.qty, unitPrice: undefined }))
    if (add.length > 0) form.setFieldValue('items', [...cur, ...add])
  }
  useEffect(() => {
    autoAddSupplierParts(bomParts, watchedSupplierId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedSupplierId])

  async function loadProductBom(productId: number | undefined) {
    if (!productId) {
      setBomParts([])
      return
    }
    try {
      const r = await api.get<BomPart[]>('/products/' + productId + '/bom')
      setBomParts(r.data)
      // 已选供应商时，自动带入该供应商的 BOM 零件
      autoAddSupplierParts(r.data, form.getFieldValue('supplierId') as number | undefined)
    } catch (err) {
      notifyError(err)
    }
  }

  const watchedTotal = Form.useWatch('totalPrice', form) as number | null | undefined
  const watchedItems = Form.useWatch('items', form) as ItemField[] | undefined
  const allocPreview = useMemo(
    () => allocate((watchedItems ?? []).filter((it) => it?.partId != null && it.qty > 0), Number(watchedTotal ?? 0) || 0),
    [watchedItems, watchedTotal],
  )

  async function handleSubmit(values: {
    supplierId: number
    name: string
    totalPrice: number
    note?: string
    items?: ItemField[]
  }) {
    const items = (values.items ?? [])
      .filter((it) => it && it.partId != null && it.qty > 0)
      .map((it) => ({ partId: it.partId, qty: it.qty, unitPrice: it.unitPrice ?? null }))
    if (items.length === 0) {
      message.error('请至少选 1 个零件')
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await api.put('/price-bundles/' + editing.id, {
          supplierId: values.supplierId,
          name: values.name,
          totalPrice: values.totalPrice,
          note: values.note || null,
          items,
        })
        message.success('套餐已更新，分摊单价已回写零件')
      } else {
        await api.post('/price-bundles', {
          supplierId: values.supplierId,
          name: values.name,
          totalPrice: values.totalPrice,
          note: values.note || null,
          items,
        })
        message.success('套餐已保存，分摊单价已回写零件')
      }
      setModalOpen(false)
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(b: Bundle) {
    try {
      await api.delete('/price-bundles/' + b.id)
      message.success('套餐已删除（零件套餐关联已解除，价格保留为手填价）')
      await load()
    } catch (err) {
      notifyError(err)
    }
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="套餐价：供应商把一批零件按「每套产品用量」报一口价（如 21 个零件每套共 ¥X）。保存后系统按用量自动分摊出每个零件的单价并回写零件价格（等额单价法，个别件可手改单价，剩余金额自动摊给其余件）。"
      />
      <Table<Bundle>
        rowKey="id"
        loading={loading}
        dataSource={bundles}
        pagination={false}
        columns={[
          { title: '套餐名', dataIndex: 'name' },
          { title: '供应商', dataIndex: 'supplierName', width: 200 },
          { title: '每套总价', dataIndex: 'totalPrice', width: 120, render: (v: number) => '¥' + money(v) },
          { title: '零件数', key: 'count', width: 90, render: (_: unknown, b: Bundle) => b.items.length },
          { title: '备注', dataIndex: 'note', render: (v: string | null) => v || '-' },
          {
            title: '操作',
            key: 'ops',
            width: 150,
            render: (_: unknown, b: Bundle) =>
              canCreate ? (
                <Space>
                  <Button size="small" type="link" onClick={() => openEdit(b)}>
                    编辑
                  </Button>
                  <Popconfirm title="删除套餐？成员零件会解除套餐关联（价格保留）" onConfirm={() => handleDelete(b)}>
                    <Button size="small" type="link" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ) : null,
          },
        ]}
      />
      {canCreate ? (
        <Button type="primary" icon={<PlusOutlined />} style={{ marginTop: 12 }} onClick={openCreate}>
          新建套餐
        </Button>
      ) : null}

      <Modal
        title={editing ? '编辑套餐' : '新建套餐'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        width={900}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Space wrap>
            <Form.Item name="supplierId" label="供应商" rules={[{ required: true, message: '供应商必填' }]}>
              <Select
                showSearch
                optionFilterProp="label"
                style={{ width: 260 }}
                placeholder="选择供应商"
                options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Form.Item>
            <Form.Item name="name" label="套餐名" rules={[{ required: true, message: '套餐名必填' }]}>
              <Input placeholder="如：XX供应商21件套餐" style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="totalPrice" label="每套总价" rules={[{ required: true, message: '总价必填' }]}>
              <InputNumber min={0} precision={2} style={{ width: 140 }} placeholder="0.00" />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input placeholder="选填，如：含税口径/21件打包" />
          </Form.Item>
          <Form.Item label="选成品带出 BOM 零件（可选，多选几次可跨成品）">
            <Select
              showSearch
              allowClear
              optionFilterProp="label"
              style={{ width: 400 }}
              placeholder="选择成品 → 加载其 BOM 零件作为候选"
              onChange={(v) => loadProductBom(v as number | undefined)}
              options={products.map((p) => ({ value: p.id, label: p.sku + '　' + p.name }))}
            />
          </Form.Item>
          <Form.List name="items">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => {
                  const it = (watchedItems ?? [])[field.name] as ItemField | undefined
                  const allocated = it?.partId != null ? allocPreview.get(it.partId) : undefined
                  return (
                    <div key={field.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                      <Form.Item name={[field.name, 'partId']} rules={[{ required: true, message: '零件' }]} style={{ marginBottom: 0, flex: 1 }}>
                        <Select
                          showSearch
                          optionFilterProp="label"
                          placeholder="零件（SKU + 名称）"
                          onChange={(v: number) => {
                            const bp = bomParts.find((x) => x.partId === v)
                            const cur = (form.getFieldValue('items') as ItemField[] | undefined)?.[field.name]
                            form.setFieldValue(['items', field.name], {
                              partId: v,
                              sku: bp?.part.sku ?? cur?.sku ?? '',
                              partName: bp?.part.name ?? cur?.partName ?? '',
                              qty: bp?.qty ?? cur?.qty ?? 1,
                              unitPrice: cur?.unitPrice,
                            })
                          }}
                          options={(() => {
                            const curItems = ((form.getFieldValue('items') as ItemField[] | undefined) ?? []).map((x) => ({
                              value: x?.partId as number,
                              label: (x?.sku ?? '') + '　' + (x?.partName ?? ''),
                            }))
                            const fromBom = bomParts.map((bp) => {
                              const sup = suppliers.find((s) => s.id === bp.part.supplierId)
                              const supLabel = sup ? (sup.shortName || sup.name) : ''
                              return {
                                value: bp.partId,
                                label:
                                  bp.part.sku +
                                  '　' +
                                  bp.part.name +
                                  (bp.part.sourcing !== 'purchased' ? '（' + (bp.part.sourcing === 'selfbuy' ? '自购' : '自制') + '）' : '') +
                                  (supLabel ? '　[' + supLabel + ']' : ''),
                              }
                            })
                            const merged = [...fromBom]
                            for (const c of curItems) if (!merged.some((m) => m.value === c.value)) merged.push(c)
                            return merged
                          })()} 
                        />
                      </Form.Item>
                      <Form.Item name={[field.name, 'qty']} rules={[{ required: true, message: '用量' }]} style={{ marginBottom: 0 }}>
                        <InputNumber min={1} precision={0} placeholder="每套用量" style={{ width: 100 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'unitPrice']} style={{ marginBottom: 0 }}>
                        <InputNumber min={0} precision={2} placeholder="手改单价(可选)" style={{ width: 130 }} />
                      </Form.Item>
                      <span style={{ minWidth: 90, color: allocated != null ? '#1677ff' : '#999' }}>
                        {allocated != null ? '分摊 ¥' + allocated.toFixed(2) : '—'}
                      </span>
                      <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                    </div>
                  )
                })}
                <Button type="dashed" onClick={() => add({ partId: undefined, qty: 1 })} block icon={<PlusOutlined />}>
                  添加零件
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </div>
  )
}
