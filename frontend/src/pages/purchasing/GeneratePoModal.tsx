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
  Spin,
  Tag,
  message,
} from 'antd'
import { PlusOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { api } from '../../api'
import { dateStr, notifyError } from '../common'
import type { Paged } from '../common'
import { poLetter } from './helpers'
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
  /** 准备中（父层按钮转圈同步）：true 时弹窗内只显示转圈 */
  busy: boolean
  /** 明细初始化完成后回调（父层停转圈） */
  onReady: () => void
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
    busy,
    onReady,
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

  // 自购供应商（shortName=自购）：自购件归入它的「自购」采购单
  const selfBuySup = useMemo(() => suppliers.find((s) => s.shortName === '自购'), [suppliers])

  // 打开弹窗：弹窗内先检查所选订单是否已生成过采购单（转圈），通过后再初始化明细
  useEffect(() => {
    if (!open) return
    const checks = orderIds.map((id) =>
      api.get<Paged<PurchaseOrder>>('/purchase-orders', { params: { salesOrderId: id, page: 1, pageSize: 100 } }),
    )
    Promise.all(checks)
      .then((results) => {
        const existing = results.flatMap((r) => (r.data.items ?? []).map((p) => p.orderNo))
        if (existing.length > 0) {
          Modal.confirm({
            title: '所选订单已生成过采购单',
            content:
              '已存在：' +
              existing.join('、') +
              '。确认继续生成新的采购单吗？新采购单会关联到同一销售订单，收货后一起计算采购进度。',
            okText: '继续生成',
            cancelText: '取消',
            onOk: () => initItems(),
            onCancel: () => onCancel(),
          })
        } else {
          initItems()
        }
      })
      .catch((err) => {
        notifyError(err)
        onCancel()
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 初始化明细：优先恢复 keepAlive 草稿，否则按建议采购量预填
  function initItems() {
    const firstReq = requirements[0]
    const firstSup = suppliers.find((s) => s.id === firstReq?.supplierId) ?? suppliers[0]
    const defaults = {
      orderDate: dateStr(new Date()),
      paymentTerms: firstSup?.defaultPaymentTerms ?? undefined,
      headerName: firstSup?.defaultHeaderName || DEFAULT_HEADER,
    }
    if (draftItems && draftItems.length > 0) {
      form.setFieldsValue({ ...defaults, items: draftItems })
      onReady()
      return
    }
    // 套餐价合并：同一套餐的成员零件合成一条「套餐」行（数量=套数、单价=每套总价），提交时展开
    const items: PoItemField[] = []
    const seenBundles = new Set<number>()
    for (const r of requirements) {
      if (!r.includeInPo || (r.suggestedQty ?? r.gapQty) <= 0) continue
      if (r.priceBundleId != null) {
        if (seenBundles.has(r.priceBundleId)) continue
        seenBundles.add(r.priceBundleId)
        const sets = r.bundleItemQty ? Math.max(1, Math.round(r.requiredQty / r.bundleItemQty)) : 1
        items.push({
          bundleId: r.priceBundleId,
          bundleName: r.bundleName ?? '套餐',
          qty: sets,
          unitPrice: r.bundleTotalPrice ?? undefined,
          unitPriceInclTax: r.bundleTotalPrice ?? undefined,
          supplierId: r.supplierId ?? undefined,
        })
      } else {
        const isSelfBuy = r.sourcing === 'selfbuy'
        items.push({
          partId: r.partId,
          qty: Math.ceil(r.suggestedQty ?? r.gapQty ?? 0),
          unitPrice: r.price ?? undefined,
          unitPriceInclTax: r.priceInclTax ?? r.price ?? undefined,
          supplierId: isSelfBuy ? (selfBuySup?.id ?? undefined) : (r.supplierId ?? undefined),
          selfBuy: isSelfBuy || undefined,
          usage: r.usage ?? undefined,
        })
      }
    }
    form.setFieldsValue({ ...defaults, items })
    onReady()
  }

  const watchedItems = Form.useWatch('items', form) as PoItemField[] | undefined

  // keepAlive：把弹窗明细写回壳层
  useEffect(() => {
    if (!open) return
    onDraftItems(watchedItems ?? [])
  }, [watchedItems, open, onDraftItems])

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
    if (fields.length > 0) {
      form.setFields(fields)
      // 自购组改选真实供应商 → 变正常外购单
      form.setFields(
        indices.map((i) => ({ name: ['items', i, 'selfBuy'] as ['items', number, 'selfBuy'], value: false })),
      )
    }
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
      selfBuy?: boolean
    }[] = []
    for (const it of values.items ?? []) {
      // 套餐合并行：展开成成员零件行（数量按套数比例换算，单价用分摊单价）
      if (it.bundleId != null) {
        if (it.unitPrice == null) {
          const bidx = values.items?.indexOf(it) ?? 0
          message.error('套餐「' + (it.bundleName ?? '') + '」缺少价格，请填写单价')
          form.setFields([{ name: ['items', bidx, 'unitPrice'], errors: ['缺少价格'] }])
          form.scrollToField(['items', bidx, 'unitPrice'])
          return
        }
        const members = requirements.filter((x) => x.priceBundleId === it.bundleId)
        const m0 = members[0]
        const baseSets = m0 && m0.bundleItemQty ? m0.requiredQty / m0.bundleItemQty : 1
        for (const m of members) {
          const perSet = baseSets > 0 ? m.requiredQty / baseSets : 0
          const base = {
            partId: m.partId,
            unitPrice: Number(m.price ?? m.priceInclTax ?? 0),
            unitPriceInclTax: m.priceInclTax ?? m.price ?? undefined,
            usage: m.usage != null ? m.usage : undefined,
            note: it.note || undefined,
            supplierId: m.supplierId ?? undefined,
          }
          flat.push({
            ...base,
            qty: Math.max(1, Math.round(Number(it.qty ?? 0) * perSet)),
            supplierReplyDate: it.supplierReplyDate ?? undefined,
            splitNo: 0,
          })
        }
        continue
      }
      const partId = Number(it.partId ?? 0)
      const inclPrice = it.unitPriceInclTax != null ? Number(it.unitPriceInclTax) : null
      const rawPrice = it.unitPrice == null ? null : Number(it.unitPrice)
      if (rawPrice == null && inclPrice == null) {
        const idx = values.items?.indexOf(it) ?? 0
        const part = requirements.find((x) => x.partId === partId)
        const label = (part ? part.sku + ' ' + part.partName : '第 ' + (idx + 1) + ' 行') + '：不含税单价/含税单价至少填一个'
        message.error('缺少价格 → ' + label)
        form.setFields([
          { name: ['items', idx, 'unitPrice'], errors: [part ? part.sku + ' 缺少价格' : '缺少价格'] },
          { name: ['items', idx, 'unitPriceInclTax'], errors: [part ? part.sku + ' 缺少价格' : '缺少价格'] },
        ])
        form.scrollToField(['items', idx, 'unitPrice'])
        return
      }
      const unitPrice = rawPrice ?? inclPrice ?? 0
      const base = {
        partId,
        unitPrice,
        unitPriceInclTax: inclPrice != null ? inclPrice : undefined,
        usage: it.usage != null ? Number(it.usage) : undefined,
        note: it.note || undefined,
        supplierId: it.supplierId ?? undefined,
        selfBuy: it.selfBuy === true,
      }
      flat.push({
        ...base,
        qty: Number(it.qty ?? 0),
        supplierReplyDate: it.supplierReplyDate ?? undefined,
        splitNo: 0,
      })
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
          selfBuy: r.selfBuy,
        })),
      })
      const selfBuyNos = data.filter((o) => o.poType === 'selfbuy').map((o) => o.orderNo)
      message.success(
        '已生成 ' + data.length + ' 张采购单：' + data.map((o) => o.orderNo).join('、') +
          (selfBuyNos.length > 0 ? '（自购单 ' + selfBuyNos.join('、') + '：老板自己买，买回后照常收货入库）' : ''),
      )
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
      {submitting ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2100,
            background: 'rgba(255,255,255,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spin size="large" tip="正在生成采购单，请稍候…">
            <div style={{ minWidth: 240, minHeight: 90 }} />
          </Spin>
        </div>
      ) : null}
      {busy ? (
        <div style={{ textAlign: 'center', padding: '48px 0' }}>
          <Spin size="large" tip="正在检查订单并准备采购单…">
            <div style={{ minWidth: 220, minHeight: 80 }} />
          </Spin>
        </div>
      ) : (
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
        {(() => {
          const selfBuy = (watchedItems ?? []).filter((it) => {
            const req = requirements.find((r) => r.partId === it?.partId)
            return req?.sourcing === 'selfbuy'
          })
          return selfBuy.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={
                '本单包含 ' +
                selfBuy.length +
                ' 个自购件（库存不足本次需要买）。生成后归入「自购」采购单（类型=自购、单号=订单号-自购），不出给供应商，买回后照常收货入库。'
              }
            />
          ) : null
        })()}

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
                const isSelfBuyGroup = firstIt?.selfBuy === true
                const isDefaultSupplier =
                  !isSelfBuyGroup && firstReq?.supplierId != null && firstIt?.supplierId === firstReq.supplierId
                const isChanged = !isSelfBuyGroup && firstIt?.supplierId != null && !isDefaultSupplier
                const isMissing = !isSelfBuyGroup && firstIt?.supplierId == null
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
                      {isSelfBuyGroup ? (
                        <Tag color="gold">自购（自己买，不出给供应商）</Tag>
                      ) : isMissing ? (
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
                        const isBundleRow = it?.bundleId != null
                        const req = requirements.find((r) => r.partId === it?.partId)
                        const bundleMembers = isBundleRow
                          ? requirements.filter((x) => x.priceBundleId === it?.bundleId)
                          : []
                        const isSelfBuy = req?.sourcing === 'selfbuy'
                        return (
                          <div
                            key={field.key}
                            style={{
                              borderTop: index !== group.indices[0] ? '1px dashed #d9d9d9' : 'none',
                              paddingTop: index !== group.indices[0] ? 10 : 4,
                              paddingBottom: 6,
                              background: isSelfBuy ? '#fff7e6' : undefined,
                              borderRadius: isSelfBuy ? 6 : undefined,
                            }}
                          >
                            {isSelfBuy ? (
                              <Tag color="orange" style={{ marginBottom: 6 }}>
                                自购件·库存不足带入（平时自己买，请留意）
                              </Tag>
                            ) : null}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
                              {isBundleRow ? (
                                <span
                                  style={{
                                    width: 250,
                                    lineHeight: '32px',
                                    fontWeight: 600,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  <Tag color="purple" style={{ marginRight: 6 }}>
                                    套餐·{bundleMembers.length}件
                                  </Tag>
                                  {it?.bundleName}
                                </span>
                              ) : (
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
                                    form.setFields([
                                      { name: ['items', field.name, 'qty'], value: r?.suggestedQty != null ? Math.ceil(r.suggestedQty) : r?.gapQty != null ? Math.ceil(r.gapQty) : undefined },
                                      { name: ['items', field.name, 'unitPrice'], value: r?.price ?? undefined },
                                      { name: ['items', field.name, 'supplierId'], value: r?.supplierId ?? undefined },
                                      {
                                        name: ['items', field.name, 'unitPriceInclTax'],
                                        value: r?.priceInclTax ?? r?.price ?? undefined,
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
                              )}
                              <Form.Item
                                name={[field.name, 'qty']}
                                rules={[{ required: true, message: '数量' }]}
                                style={{ marginBottom: 0 }}
                              >
                                <InputNumber min={1} precision={0} step={1} placeholder="数量" />
                              </Form.Item>
                              <Form.Item
                                name={[field.name, 'unitPrice']}
                                style={{ marginBottom: 0 }}
                              >
                                <InputNumber
                                  min={0}
                                  precision={4}
                                  placeholder="不含税单价"
                                  style={{ width: 130 }}
                                />
                              </Form.Item>
                              <Form.Item name={[field.name, 'unitPriceInclTax']} style={{ marginBottom: 0 }}>
                                <InputNumber min={0} precision={4} placeholder="含税单价" style={{ width: 130 }} />
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
                              {isBundleRow
                                ? '套餐 ' +
                                  bundleMembers.length +
                                  ' 件 ｜每套总价 ¥' +
                                  (it?.unitPrice ?? '-') +
                                  ' ｜需求 ' +
                                  (it?.qty ?? '-') +
                                  ' 套（数量=套数）'
                                : req
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
      )}
    </Modal>
  )
}
