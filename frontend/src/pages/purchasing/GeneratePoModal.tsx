import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tag,
  message,
} from 'antd'
import { PlusOutlined, MinusCircleOutlined, SplitCellsOutlined } from '@ant-design/icons'
import { api } from '../../api'
import { dateStr, notifyError } from '../common'
import { calcInclTax, poLetter } from './helpers'
import type {
  CompanyHeader,
  PoFormValues,
  PoItemField,
  PurchaseOrder,
  Requirement,
  Supplier,
} from './types'

const DEFAULT_HEADER = '东莞市智锐恒电子有限公司'

interface Props {
  open: boolean
  orderIds: number[]
  selectedOrderNos: string[]
  requirements: Requirement[]
  suppliers: Supplier[]
  companyHeaders: CompanyHeader[]
  draftItems?: PoItemField[]
  onDraftItems: (items: PoItemField[] | undefined) => void
  onCancel: () => void
  onSuccess: (data: PurchaseOrder[]) => void
}

export default function GeneratePoModal(props: Props) {
  const {
    open,
    orderIds,
    selectedOrderNos,
    requirements,
    suppliers,
    companyHeaders,
    draftItems,
    onDraftItems,
    onCancel,
    onSuccess,
  } = props
  const [form] = Form.useForm<PoFormValues>()
  const [submitting, setSubmitting] = useState(false)

  const headerOptions = useMemo(() => {
    const opts = companyHeaders.map((h) => ({ value: h.name, label: h.name }))
    if (!opts.some((o) => o.value === DEFAULT_HEADER)) {
      opts.unshift({ value: DEFAULT_HEADER, label: DEFAULT_HEADER })
    }
    return opts
  }, [companyHeaders])

  // 打开弹窗时初始化：优先恢复 keepAlive 草稿，否则按建议采购量预填
  useEffect(() => {
    if (!open) return
    const firstReq = requirements[0]
    const firstSup = suppliers.find((s) => s.id === firstReq?.supplierId) ?? suppliers[0]
    const defaults = {
      orderDate: dateStr(new Date()),
      paymentTerms: firstSup?.defaultPaymentTerms ?? undefined,
      headerName: firstSup?.defaultHeaderName || DEFAULT_HEADER,
      taxPoint: firstSup?.taxPoint ?? undefined,
    }
    if (draftItems && draftItems.length > 0) {
      form.setFieldsValue({ ...defaults, items: draftItems })
      return
    }
    const items: PoItemField[] = requirements
      .filter((r) => (r.suggestedQty ?? r.gapQty) > 0)
      .map((r) => {
        const sup = suppliers.find((s) => s.id === r.supplierId)
        return {
          partId: r.partId,
          qty: r.suggestedQty ?? r.gapQty,
          unitPrice: r.price ?? undefined,
          unitPriceInclTax: calcInclTax(r.price, sup?.taxPoint),
          supplierId: r.supplierId ?? undefined,
          usage: r.usage ?? undefined,
        }
      })
    form.setFieldsValue({ ...defaults, items })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const watchedItems = Form.useWatch('items', form) as PoItemField[] | undefined

  // keepAlive：把弹窗明细（含拆单子批次）写回壳层
  useEffect(() => {
    if (!open) return
    onDraftItems(watchedItems ?? [])
  }, [watchedItems, open, onDraftItems])

  function supplierTaxPoint(supplierId: number | null | undefined): number | null | undefined {
    const sup = suppliers.find((s) => s.id === supplierId)
    if (sup?.taxPoint != null) return sup.taxPoint
    return (form.getFieldValue('taxPoint') as number | null | undefined) ?? 0
  }

  // 编号预览：按供应商分组数预估，使用选中订单号 + 字母（跳 I/O）
  const preview = useMemo(() => {
    const groups: string[] = []
    for (const it of watchedItems ?? []) {
      if (!it?.partId) continue
      const req = requirements.find((r) => r.partId === it.partId)
      const sup = suppliers.find((s) => s.id === it.supplierId)
      const name = sup?.name || req?.supplierName || '未设置供应商'
      if (!groups.includes(name)) groups.push(name)
    }
    const base =
      selectedOrderNos.length === 1
        ? selectedOrderNos[0]
        : [...selectedOrderNos].sort().join('-')
    const letters = groups.map((_, i) => poLetter(i))
    return { count: groups.length, base, letters }
  }, [watchedItems, requirements, suppliers, selectedOrderNos])

  // 按供应商分组（老板反馈：同供应商只显示一次、放最左边、组间有明显分界线）
  // 组顺序 = 首次出现顺序；未设置供应商的归「未设置」组
  const grouped = useMemo(() => {
    const map = new Map<string, number[]>()
    ;(watchedItems ?? []).forEach((it, i) => {
      const key = it?.supplierId == null ? '__none__' : String(it.supplierId)
      const list = map.get(key) ?? []
      list.push(i)
      map.set(key, list)
    })
    return [...map.entries()].map(([key, indices]) => {
      const sup = key === '__none__' ? null : suppliers.find((s) => String(s.id) === key)
      return { key, sup, supName: sup?.name ?? '未设置供应商', indices }
    })
  }, [watchedItems, suppliers])

  function changeGroupSupplier(key: string, supplierId: number | undefined) {
    const indices = grouped.find((g) => g.key === key)?.indices ?? []
    const fields = indices.map((i) => ({
      name: ['items', i, 'supplierId'] as ['items', number, 'supplierId'],
      value: supplierId,
    }))
    if (fields.length > 0) form.setFields(fields)
    // 组内各行按新供应商加税点重算含税价
    indices.forEach((i) => {
      const price = form.getFieldValue(['items', i, 'unitPrice']) as number | null | undefined
      form.setFieldValue(['items', i, 'unitPriceInclTax'], calcInclTax(price, supplierTaxPoint(supplierId)))
    })
  }

  async function handleSubmit(values: PoFormValues) {
    const flat: {
      partId: number
      qty: number
      unitPrice: number
      unitPriceInclTax?: number
      usage?: number
      note?: string
      supplierReplyDate?: string
      splitNo: number
      supplierId?: number
    }[] = []
    for (const it of values.items ?? []) {
      const partId = Number(it.partId ?? 0)
      const unitPrice = Number(it.unitPrice ?? 0)
      const base = {
        partId,
        unitPrice,
        unitPriceInclTax: it.unitPriceInclTax != null ? Number(it.unitPriceInclTax) : undefined,
        usage: it.usage != null ? Number(it.usage) : undefined,
        note: it.note || undefined,
        supplierId: it.supplierId ?? undefined,
      }
      if (it.splits && it.splits.length > 0) {
        it.splits.forEach((s, si) => {
          flat.push({
            ...base,
            qty: Number(s.qty ?? 0),
            supplierReplyDate: s.expectedDeliveryDate ?? undefined,
            splitNo: si,
          })
        })
      } else {
        flat.push({
          ...base,
          qty: Number(it.qty ?? 0),
          supplierReplyDate: it.supplierReplyDate ?? undefined,
          splitNo: 0,
        })
      }
    }

    // 原本没挂（或换了）供应商的零件选了供应商 → 询问是否同步回零件资料
    let syncAssignments = false
    const assignments = flat.filter((r) => {
      const req = requirements.find((x) => x.partId === r.partId)
      return r.partId > 0 && r.supplierId != null && r.supplierId !== (req?.supplierId ?? null)
    })
    if (assignments.length > 0) {
      syncAssignments = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: '同步供应商到零件资料？',
          content:
            '本次为 ' +
            assignments.length +
            ' 个零件选择了供应商。是否同时更新到零件资料？选「仅本次生效」则只按本次采购单分组，不改零件资料。',
          okText: '同步并生成采购单',
          cancelText: '仅本次生效',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      })
    }

    setSubmitting(true)
    try {
      if (syncAssignments && assignments.length > 0) {
        await Promise.all(
          assignments.map((a) => api.put('/parts/' + a.partId, { supplierId: a.supplierId })),
        )
      }
      const { data } = await api.post<PurchaseOrder[]>('/purchase-orders/batch', {
        salesOrderIds: orderIds,
        poType: 'normal',
        orderDate: values.orderDate || undefined,
        expectedDeliveryDate: values.expectedDeliveryDate || undefined,
        paymentTerms: values.paymentTerms || undefined,
        termsNote: values.termsNote || undefined,
        headerName: values.headerName || undefined,
        taxPoint: values.taxPoint ?? undefined,
        manualOrderNo: values.manualOrderNo || undefined,
        items: flat.map((r) => ({
          partId: r.partId,
          qty: r.qty,
          unitPrice: r.unitPrice,
          unitPriceInclTax: r.unitPriceInclTax,
          usage: r.usage,
          note: r.note,
          supplierReplyDate: r.supplierReplyDate,
          splitNo: r.splitNo,
          supplierId: r.supplierId,
        })),
      })
      message.success('已按供应商生成 ' + data.length + ' 张采购单：' + data.map((o) => o.orderNo).join('、'))
      form.resetFields()
      onSuccess(data)
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title="生成采购单"
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      width={1180}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            '预计生成 ' +
            preview.count +
            ' 张单：' +
            preview.letters.slice(0, 5).map((l) => preview.base + l).join('、') +
            (preview.letters.length > 5 ? '…' : '') +
            '（按供应商分组预估，以生成为准）'
          }
        />

        <Space wrap style={{ marginBottom: 8 }}>
          <Form.Item name="orderDate" label="下单日期" style={{ marginBottom: 8 }}>
            <Input type="date" style={{ width: 170 }} />
          </Form.Item>
          <Form.Item name="expectedDeliveryDate" label="预计交货时间" style={{ marginBottom: 8 }}>
            <Input type="date" style={{ width: 170 }} />
          </Form.Item>
          <Form.Item name="paymentTerms" label="付款方式" style={{ marginBottom: 8 }}>
            <Input placeholder="如：月结30天" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="headerName" label="抬头" style={{ marginBottom: 8 }}>
            <Select style={{ width: 240 }} options={headerOptions} placeholder="选择抬头" />
          </Form.Item>
          <Form.Item name="taxPoint" label="加税点数(%)" style={{ marginBottom: 8 }}>
            <InputNumber min={0} max={100} precision={2} style={{ width: 120 }} placeholder="0" />
          </Form.Item>
          <Form.Item name="manualOrderNo" label="手工编号（选填）" style={{ marginBottom: 8 }}>
            <Input style={{ width: 180 }} placeholder="留空自动编号" />
          </Form.Item>
        </Space>
        <Form.Item name="termsNote" label="备注条款" style={{ marginBottom: 12 }}>
          <Input.TextArea rows={2} placeholder="选填，会写入采购单" />
        </Form.Item>

        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              {grouped.map((group) => {
                const firstIdx = group.indices[0]
                const firstIt = watchedItems?.[firstIdx]
                const firstReq = requirements.find((r) => r.partId === firstIt?.partId)
                const isDefaultSupplier =
                  firstReq?.supplierId != null && firstIt?.supplierId === firstReq.supplierId
                const isChanged = firstIt?.supplierId != null && !isDefaultSupplier
                const isMissing = firstIt?.supplierId == null
                return (
                  <div
                    key={'group-' + group.key}
                    style={{
                      border: '2px solid #91caff',
                      borderRadius: 8,
                      marginBottom: 16,
                      background: '#fafcff',
                    }}
                  >
                    {/* 供应商分组头：供应商放最左、只显示一次、组间明显分界线 */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                        background: '#e6f4ff',
                        borderBottom: '2px solid #91caff',
                        borderTopLeftRadius: 6,
                        borderTopRightRadius: 6,
                      }}
                    >
                      <span style={{ fontWeight: 700, fontSize: 14, minWidth: 160 }}>
                        {group.supName}
                      </span>
                      <Select
                        showSearch
                        optionFilterProp="label"
                        placeholder="改选供应商（整组生效）"
                        style={{ width: 200 }}
                        value={firstIt?.supplierId ?? undefined}
                        onChange={(v) => changeGroupSupplier(group.key, v)}
                        options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                      />
                      {isMissing ? (
                        <Tag color="orange">未设置供应商</Tag>
                      ) : isDefaultSupplier ? (
                        <Tag color="green">默认</Tag>
                      ) : isChanged ? (
                        <Tag color="blue">本次改选</Tag>
                      ) : null}
                      <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                        {group.indices.length} 项
                      </span>
                    </div>

                    {/* 组内明细行 */}
                    <div style={{ padding: '4px 12px 12px' }}>
                      {group.indices.map((index) => {
                        const field = fields[index]!
                        const it = watchedItems?.[index]
                        const req = requirements.find((r) => r.partId === it?.partId)
                        const hasSplit = it?.splits != null && it.splits.length > 0
                        return (
                          <div
                            key={field.key}
                            style={{
                              borderTop: index !== group.indices[0] ? '1px dashed #d9d9d9' : 'none',
                              paddingTop: index !== group.indices[0] ? 10 : 4,
                              paddingBottom: 6,
                            }}
                          >
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
                              <Form.Item
                                name={[field.name, 'partId']}
                                rules={[{ required: true, message: '零件' }]}
                                style={{ marginBottom: 0, width: 250 }}
                              >
                                <Select
                                  showSearch
                                  optionFilterProp="label"
                                  placeholder="零件（SKU + 名称）"
                                  onChange={(v) => {
                                    const r = requirements.find((x) => x.partId === v)
                                    const sup = suppliers.find((s) => s.id === r?.supplierId)
                                    form.setFields([
                                      { name: ['items', field.name, 'qty'], value: r?.suggestedQty ?? r?.gapQty ?? undefined },
                                      { name: ['items', field.name, 'unitPrice'], value: r?.price ?? undefined },
                                      { name: ['items', field.name, 'supplierId'], value: r?.supplierId ?? undefined },
                                      {
                                        name: ['items', field.name, 'unitPriceInclTax'],
                                        value: calcInclTax(r?.price, sup?.taxPoint ?? supplierTaxPoint(r?.supplierId)),
                                      },
                                      { name: ['items', field.name, 'usage'], value: r?.usage ?? undefined },
                                    ])
                                  }}
                                  options={requirements.map((r) => ({
                                    value: r.partId,
                                    label: r.sku + '　' + r.partName,
                                  }))}
                                />
                              </Form.Item>
                              <Form.Item
                                name={[field.name, 'qty']}
                                rules={[{ required: !hasSplit, message: '数量' }]}
                                style={{ marginBottom: 0 }}
                              >
                                <InputNumber min={1} precision={0} step={1} placeholder="数量" disabled={hasSplit} />
                              </Form.Item>
                              <Form.Item
                                name={[field.name, 'unitPrice']}
                                rules={[{ required: true, message: '不含税单价' }]}
                                style={{ marginBottom: 0 }}
                              >
                                <InputNumber
                                  min={0}
                                  precision={4}
                                  placeholder="不含税单价"
                                  style={{ width: 130 }}
                                  onChange={(v) => {
                                    const supId = form.getFieldValue(['items', field.name, 'supplierId']) as number | null | undefined
                                    form.setFieldValue(
                                      ['items', field.name, 'unitPriceInclTax'],
                                      calcInclTax(v as number | null, supplierTaxPoint(supId)),
                                    )
                                  }}
                                />
                              </Form.Item>
                              <Form.Item name={[field.name, 'unitPriceInclTax']} style={{ marginBottom: 0 }}>
                                <InputNumber min={0} precision={2} placeholder="含税单价" style={{ width: 130 }} />
                              </Form.Item>
                              <Form.Item name={[field.name, 'note']} style={{ marginBottom: 0 }}>
                                <Input placeholder="备注" style={{ width: 160 }} />
                              </Form.Item>
                              <Button
                                type="text"
                                danger
                                icon={<MinusCircleOutlined />}
                                onClick={() => remove(field.name)}
                              />
                            </div>
                            <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 6 }}>
                              {req
                                ? '用量 ' +
                                  (req.usageText ?? req.usage ?? '-') +
                                  ' ｜需求 ' +
                                  req.requiredQty +
                                  ' ｜库存 ' +
                                  req.onHand +
                                  ' ｜缺口 ' +
                                  req.gapQty +
                                  ' ｜建议采购 ' +
                                  (req.suggestedQty ?? req.gapQty) +
                                  (req.moq != null ? ' ｜MOQ ' + req.moq : '') +
                                  (req.safetyStock != null ? ' ｜安全库存 ' + req.safetyStock : '') +
                                  (req.isCommonPart ? ' ｜共用料' : '')
                                : ''}
                            </div>

                            <Form.List name={[field.name, 'splits']}>
                              {(splitFields, splitOps) => (
                                <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: '3px solid #91caff' }}>
                                  {splitFields.length === 0 ? (
                                    <Button
                                      size="small"
                                      type="link"
                                      icon={<SplitCellsOutlined />}
                                      onClick={() => {
                                        splitOps.add({ qty: it?.qty ?? undefined, expectedDeliveryDate: undefined })
                                        splitOps.add({ qty: undefined, expectedDeliveryDate: undefined })
                                      }}
                                    >
                                      拆单
                                    </Button>
                                  ) : (
                                    <>
                                      <div style={{ marginBottom: 6, color: '#1677ff' }}>
                                        已拆单：{splitFields.length} 个子批次，提交时同供应商同批次合成一张单
                                      </div>
                                      {splitFields.map((sf, si) => (
                                        <div key={sf.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                                          <Tag color="blue">批次 {si}</Tag>
                                          <Form.Item
                                            name={[sf.name, 'qty']}
                                            rules={[{ required: true, message: '数量' }]}
                                            style={{ marginBottom: 0 }}
                                          >
                                            <InputNumber min={1} precision={0} placeholder="数量" />
                                          </Form.Item>
                                          <Form.Item name={[sf.name, 'expectedDeliveryDate']} style={{ marginBottom: 0 }}>
                                            <Input type="date" placeholder="预计交货日期" style={{ width: 170 }} />
                                          </Form.Item>
                                          <Button
                                            type="text"
                                            danger
                                            size="small"
                                            icon={<MinusCircleOutlined />}
                                            onClick={() => splitOps.remove(sf.name)}
                                          />
                                        </div>
                                      ))}
                                      <Space>
                                        <Button
                                          size="small"
                                          type="dashed"
                                          icon={<PlusOutlined />}
                                          onClick={() => splitOps.add({ qty: undefined, expectedDeliveryDate: undefined })}
                                        >
                                          添加批次
                                        </Button>
                                        <Button
                                          size="small"
                                          onClick={() => splitOps.remove(splitFields.map((sf) => sf.name))}
                                        >
                                          取消拆单
                                        </Button>
                                      </Space>
                                    </>
                                  )}
                                </div>
                              )}
                            </Form.List>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                添加明细
              </Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  )
}
