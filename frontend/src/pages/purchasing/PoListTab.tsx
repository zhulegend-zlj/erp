import { useEffect, useState } from 'react'
import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Upload,
  message,
} from 'antd'
import {
  UploadOutlined,
  DownloadOutlined,
  EyeOutlined,
  PaperClipOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons'
import { api } from '../../api'
import { dateStr, money, notifyError } from '../common'
import type { Paged } from '../common'
import {
  nextPoStatus,
  PO_STATUS_META,
  PO_STATUS_NEXT_LABEL,
  poTypeColor,
  poTypeLabel,
  RECEIPT_STATUS_META,
} from './helpers'
import type { CompanyHeader, PoAttachment, PoFormValues, PoPreview, PurchaseOrder, SalesOrder, Supplier } from './types'

interface Props {
  canCreate: boolean
  suppliers: Supplier[]
  companyHeaders: CompanyHeader[]
  refreshKey: number
}

export default function PoListTab(props: Props) {
  const { canCreate, suppliers, companyHeaders, refreshKey } = props
  const [rows, setRows] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)
  const [salesOrderFilter, setSalesOrderFilter] = useState<number | undefined>(undefined)
  const [supplierFilter, setSupplierFilter] = useState<number | undefined>(undefined)
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([])

  // 销售单筛选下拉数据（不选=查全部，老板反馈 2026-08-31）
  useEffect(() => {
    api
      .get<SalesOrder[]>('/orders')
      .then(({ data }) => setSalesOrders(data))
      .catch(() => setSalesOrders([]))
  }, [])

  const [editing, setEditing] = useState<PurchaseOrder | null>(null)
  const [editForm] = Form.useForm<PoFormValues>()
  const [editSaving, setEditSaving] = useState(false)

  const [attachPo, setAttachPo] = useState<PurchaseOrder | null>(null)
  const [attachments, setAttachments] = useState<PoAttachment[]>([])
  const [attachLoading, setAttachLoading] = useState(false)

  const [previewPo, setPreviewPo] = useState<PurchaseOrder | null>(null)
  const [previewData, setPreviewData] = useState<PoPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  async function loadPos(targetPage: number, size: number) {
    setLoading(true)
    try {
      const { data } = await api.get<Paged<PurchaseOrder>>('/purchase-orders', {
        params: {
          page: targetPage,
          pageSize: size,
          status: statusFilter || undefined,
          salesOrderId: salesOrderFilter ?? undefined,
          supplierId: supplierFilter ?? undefined,
          // 按编号 A、B、C… 排序（老板反馈 2026-08-31）
          sort: 'orderNo',
        },
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
    void loadPos(page, pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, statusFilter, salesOrderFilter, supplierFilter, refreshKey])

  async function advanceStatus(po: PurchaseOrder) {
    const next = nextPoStatus(po.poStatus)
    if (!next) return
    Modal.confirm({
      title: '流转状态',
      content: '确认将 ' + po.orderNo + ' 标记为「' + PO_STATUS_META[next].label + '」吗？',
      okText: PO_STATUS_NEXT_LABEL[po.poStatus],
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.patch('/purchase-orders/' + po.id + '/status', { poStatus: next })
          message.success('已更新为「' + PO_STATUS_META[next].label + '」')
          void loadPos(page, pageSize)
        } catch (err) {
          notifyError(err)
        }
      },
    })
  }

  function openEdit(po: PurchaseOrder) {
    setEditing(po)
    editForm.setFieldsValue({
      orderNo: po.orderNo,
      orderDate: po.orderDate ?? undefined,
      expectedDeliveryDate: po.expectedDeliveryDate ?? undefined,
      paymentTerms: po.paymentTerms ?? undefined,
      termsNote: po.termsNote ?? undefined,
      headerName: po.headerName ?? undefined,
      taxPoint: po.taxPoint ?? undefined,
      items: (po.items ?? []).map((it) => ({
        partId: it.partId,
        qty: it.qty,
        unitPrice: Number(it.unitPrice),
        unitPriceInclTax: it.unitPriceInclTax != null ? Number(it.unitPriceInclTax) : undefined,
        note: it.note ?? undefined,
        supplierReplyDate: it.supplierReplyDate ?? undefined,
      })),
    })
  }

  async function handleEdit(values: PoFormValues) {
    if (!editing) return
    setEditSaving(true)
    try {
      await api.patch('/purchase-orders/' + editing.id, {
        orderNo: values.orderNo || undefined,
        orderDate: values.orderDate || undefined,
        expectedDeliveryDate: values.expectedDeliveryDate || undefined,
        paymentTerms: values.paymentTerms || undefined,
        termsNote: values.termsNote || undefined,
        headerName: values.headerName || undefined,
        taxPoint: values.taxPoint ?? undefined,
        items: (values.items ?? []).map((it) => ({
          partId: Number(it.partId ?? 0),
          qty: Number(it.qty ?? 0),
          unitPrice: Number(it.unitPrice ?? 0),
          unitPriceInclTax: it.unitPriceInclTax != null ? Number(it.unitPriceInclTax) : undefined,
          note: it.note || undefined,
          supplierReplyDate: it.supplierReplyDate || undefined,
        })),
      })
      message.success('采购单已更新')
      setEditing(null)
      editForm.resetFields()
      void loadPos(page, pageSize)
    } catch (err) {
      notifyError(err)
    } finally {
      setEditSaving(false)
    }
  }

  async function loadAttachments(po: PurchaseOrder) {
    setAttachLoading(true)
    try {
      const { data } = await api.get<PoAttachment[]>('/purchase-orders/' + po.id + '/attachments')
      setAttachments(data)
    } catch (err) {
      notifyError(err)
    } finally {
      setAttachLoading(false)
    }
  }

  function openAttachments(po: PurchaseOrder) {
    setAttachPo(po)
    setAttachments([])
    void loadAttachments(po)
  }

  async function customUpload(options: { file: File; onSuccess?: () => void; onError?: (e: Error) => void }) {
    if (!attachPo) return
    try {
      const formData = new FormData()
      formData.append('file', options.file)
      const { data } = await api.post<{ url: string }>('/uploads', formData)
      await api.post('/purchase-orders/' + attachPo.id + '/attachments', {
        url: data.url,
        name: options.file.name,
      })
      message.success('回签件已上传')
      options.onSuccess?.()
      void loadAttachments(attachPo)
    } catch (err) {
      notifyError(err)
      options.onError?.(err as Error)
    }
  }

  async function deleteAttachment(po: PurchaseOrder, att: PoAttachment) {
    try {
      await api.delete('/purchase-orders/' + po.id + '/attachments/' + att.id)
      message.success('已删除回签件')
      void loadAttachments(po)
    } catch (err) {
      notifyError(err)
    }
  }

  async function openPreview(po: PurchaseOrder) {
    setPreviewPo(po)
    setPreviewData(null)
    setPreviewLoading(true)
    try {
      const { data } = await api.get<PoPreview>('/purchase-orders/' + po.id + '/preview')
      setPreviewData(data)
    } catch (err) {
      notifyError(err)
      setPreviewPo(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  async function exportPo(po: PurchaseOrder) {
    try {
      const res = await api.get('/purchase-orders/' + po.id + '/export', { responseType: 'blob' })
      const cd = (res.headers as Record<string, unknown>)['content-disposition'] as string | undefined
      const m = cd && /filename\*=UTF-8''([^;]+)/.exec(cd)
      const name = m ? decodeURIComponent(m[1] ?? '') : po.orderNo + '.xlsx'
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

  const headerOptions = companyHeaders.map((h) => ({ value: h.name, label: h.name }))

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          showSearch
          placeholder="销售单筛选（不选=全部）"
          style={{ width: 240 }}
          value={salesOrderFilter}
          optionFilterProp="label"
          onChange={(v) => {
            setSalesOrderFilter(v)
            setPage(1)
          }}
          options={salesOrders.map((o) => ({ value: o.id, label: o.orderNo }))}
        />
        <Select
          allowClear
          placeholder="供应商筛选"
          style={{ width: 220 }}
          value={supplierFilter}
          onChange={(v) => {
            setSupplierFilter(v)
            setPage(1)
          }}
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
        />
        <Select
          allowClear
          placeholder="收货进度筛选"
          style={{ width: 180 }}
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v)
            setPage(1)
          }}
          options={Object.keys(RECEIPT_STATUS_META).map((k) => ({
            value: k,
            label: RECEIPT_STATUS_META[k].label,
          }))}
        />
      </Space>

      <Table<PurchaseOrder>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        scroll={{ x: 1500 }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50, 100],
          onChange: (p, s) => {
            if (s !== pageSize) {
              setPageSize(s)
              setPage(1)
            } else {
              setPage(p)
            }
          },
        }}
        columns={[
          { title: '编号', dataIndex: 'orderNo', key: 'orderNo', width: 130, fixed: 'left' as const },
          {
            title: '流转状态',
            dataIndex: 'poStatus',
            key: 'poStatus',
            width: 240,
            render: (v: string, r: PurchaseOrder) => {
              const meta = PO_STATUS_META[v] ?? { label: v, color: 'default' }
              const next = nextPoStatus(v)
              return (
                <Space size={4}>
                  <Tag color={meta.color}>{meta.label}</Tag>
                  {canCreate && next ? (
                    <Button
                      size="small"
                      type="link"
                      icon={<ArrowRightOutlined />}
                      onClick={() => advanceStatus(r)}
                    >
                      {PO_STATUS_NEXT_LABEL[v]}
                    </Button>
                  ) : null}
                </Space>
              )
            },
          },
          { title: '供应商', dataIndex: 'supplierName', key: 'supplierName', width: 170 },
          {
            title: '关联订单',
            key: 'salesOrders',
            width: 140,
            render: (_: unknown, r: PurchaseOrder) =>
              r.salesOrders && r.salesOrders.length > 0
                ? r.salesOrders.map((o) => o.orderNo).join('、')
                : r.salesOrderNo || '-',
          },
          {
            title: '类型',
            dataIndex: 'poType',
            key: 'poType',
            width: 90,
            render: (v: string) => <Tag color={poTypeColor(v)}>{poTypeLabel(v)}</Tag>,
          },
          {
            title: '收货进度',
            dataIndex: 'status',
            key: 'status',
            width: 110,
            render: (v: string) => {
              const meta = RECEIPT_STATUS_META[v] ?? { label: v, color: 'default' }
              return <Tag color={meta.color}>{meta.label}</Tag>
            },
          },
          {
            title: '金额',
            dataIndex: 'totalAmount',
            key: 'totalAmount',
            width: 110,
            align: 'right' as const,
            render: (v: number | string) => '¥' + money(v),
          },
          {
            title: '下单日期',
            dataIndex: 'orderDate',
            key: 'orderDate',
            width: 120,
            render: (v: string | null | undefined) => dateStr(v),
          },
          {
            title: '预计交货',
            dataIndex: 'expectedDeliveryDate',
            key: 'expectedDeliveryDate',
            width: 120,
            render: (v: string | null | undefined) => dateStr(v),
          },
          ...(canCreate
            ? [
                {
                  title: '操作',
                  key: 'actions',
                  width: 260,
                  fixed: 'right' as const,
                  render: (_: unknown, r: PurchaseOrder) => (
                    <Space size={0} wrap>
                      <Button size="small" type="link" onClick={() => openEdit(r)}>
                        编辑改单
                      </Button>
                      <Button size="small" type="link" icon={<PaperClipOutlined />} onClick={() => openAttachments(r)}>
                        回签件
                      </Button>
                      <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => openPreview(r)}>
                        预览
                      </Button>
                      <Button size="small" type="link" icon={<DownloadOutlined />} onClick={() => exportPo(r)}>
                        导出
                      </Button>
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />

      <Modal
        title={editing ? '编辑采购单：' + editing.orderNo : '编辑采购单'}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={() => editForm.submit()}
        confirmLoading={editSaving}
        width={1100}
        forceRender
      >
        <Form form={editForm} layout="vertical" onFinish={handleEdit}>
          <Space wrap>
            <Form.Item name="orderNo" label="编号" style={{ marginBottom: 8 }}>
              <Input style={{ width: 180 }} />
            </Form.Item>
            <Form.Item name="orderDate" label="下单日期" style={{ marginBottom: 8 }}>
              <Input type="date" style={{ width: 170 }} />
            </Form.Item>
            <Form.Item name="expectedDeliveryDate" label="预计交货" style={{ marginBottom: 8 }}>
              <Input type="date" style={{ width: 170 }} />
            </Form.Item>
            <Form.Item name="paymentTerms" label="付款方式" style={{ marginBottom: 8 }}>
              <Input style={{ width: 180 }} />
            </Form.Item>
            <Form.Item name="headerName" label="抬头" style={{ marginBottom: 8 }}>
              <Select style={{ width: 240 }} options={headerOptions} />
            </Form.Item>
            <Form.Item name="taxPoint" label="加税点数(%)" style={{ marginBottom: 8 }}>
              <InputNumber min={0} max={100} precision={2} style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Form.Item name="termsNote" label="备注条款" style={{ marginBottom: 12 }}>
            <Input.TextArea rows={2} />
          </Form.Item>

          <Form.List name="items">
            {(fields) => (
              <>
                {fields.map((field, index) => {
                  const part = editing?.items?.[index]
                  return (
                    <div
                      key={field.key}
                      style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 8, marginBottom: 8 }}
                    >
                      <div style={{ marginBottom: 6, fontWeight: 600 }}>
                        {part ? part.sku + '　' + part.name : '明细行 ' + (index + 1)}
                      </div>
                      <Space wrap>
                        <Form.Item name={[field.name, 'qty']} rules={[{ required: true, message: '数量' }]} style={{ marginBottom: 0 }}>
                          <InputNumber min={1} precision={0} placeholder="数量" />
                        </Form.Item>
                        <Form.Item name={[field.name, 'unitPrice']} rules={[{ required: true, message: '不含税单价' }]} style={{ marginBottom: 0 }}>
                          <InputNumber min={0} precision={4} placeholder="不含税单价" style={{ width: 130 }} />
                        </Form.Item>
                        <Form.Item name={[field.name, 'unitPriceInclTax']} style={{ marginBottom: 0 }}>
                          <InputNumber min={0} precision={2} placeholder="含税单价" style={{ width: 130 }} />
                        </Form.Item>
                        <Form.Item name={[field.name, 'note']} style={{ marginBottom: 0 }}>
                          <Input placeholder="备注" style={{ width: 200 }} />
                        </Form.Item>
                        <Form.Item name={[field.name, 'supplierReplyDate']} style={{ marginBottom: 0 }}>
                          <Input type="date" placeholder="回复交期" style={{ width: 170 }} />
                        </Form.Item>
                      </Space>
                    </div>
                  )
                })}
              </>
            )}
          </Form.List>
        </Form>
      </Modal>

      <Modal
        title={attachPo ? '回签件：' + attachPo.orderNo : '回签件'}
        open={attachPo !== null}
        onCancel={() => setAttachPo(null)}
        footer={null}
        width={640}
      >
        {attachPo ? (
          <div>
            <Upload customRequest={customUpload as never} showUploadList={false} multiple>
              <Button icon={<UploadOutlined />}>上传回签件</Button>
            </Upload>
            <div style={{ marginTop: 16 }}>
              {attachLoading ? (
                <div>加载中…</div>
              ) : attachments.length === 0 ? (
                <div style={{ color: '#999' }}>暂无回签件</div>
              ) : (
                attachments.map((att) => (
                  <div key={att.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <a href={att.url} target="_blank" rel="noreferrer">
                      {att.name || att.url}
                    </a>
                    <Popconfirm title="确认删除该回签件？" onConfirm={() => deleteAttachment(attachPo, att)}>
                      <Button size="small" danger type="link">
                        删除
                      </Button>
                    </Popconfirm>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        title={previewPo ? '采购单预览：' + previewPo.orderNo : '采购单预览'}
        open={previewPo !== null}
        onCancel={() => setPreviewPo(null)}
        footer={null}
        width={900}
      >
        {previewLoading ? (
          <div>加载中…</div>
        ) : previewData ? (
          <div>
            <div style={{ marginBottom: 8 }}>
              <b>抬头：</b>
              {previewData.headerName || '-'}　<b>编号：</b>
              {previewData.orderNo}　<b>下单日期：</b>
              {dateStr(previewData.orderDate)}　<b>机型：</b>
              {previewData.model || '-'}
            </div>
            <div style={{ marginBottom: 8 }}>
              <b>供应商：</b>
              {previewData.supplier?.name || '-'}
              {previewData.supplier?.contactPerson ? '　<b>联系人：</b>' + previewData.supplier.contactPerson : ''}
              {previewData.supplier?.phone ? '　<b>电话：</b>' + previewData.supplier.phone : ''}
              {previewData.supplier?.fax ? '　<b>传真：</b>' + previewData.supplier.fax : ''}
              {previewData.supplier?.email ? '　<b>邮箱：</b>' + previewData.supplier.email : ''}
            </div>
            <div style={{ marginBottom: 8 }}>
              <b>付款方式：</b>
              {previewData.paymentTerms || '-'}　<b>预计交货：</b>
              {dateStr(previewData.expectedDeliveryDate)}　<b>加税点数：</b>
              {previewData.taxPoint ?? 0}%
            </div>
            <Table
              size="small"
              rowKey={(_, i) => String(i ?? 0)}
              dataSource={previewData.lines ?? []}
              pagination={false}
              columns={[
                { title: 'SKU', dataIndex: 'sku' },
                { title: '名称', dataIndex: 'name' },
                { title: '规格', dataIndex: 'spec', render: (v: string | null) => v || '-' },
                { title: '材质', dataIndex: 'material', render: (v: string | null) => v || '-' },
                { title: '表面处理', dataIndex: 'finish', render: (v: string | null) => v || '-' },
                { title: '单位', dataIndex: 'unit', render: (v: string | null) => v || '-' },
                { title: '用量', dataIndex: 'usage', render: (v: number | string | null) => v ?? '-' },
                { title: '数量', dataIndex: 'qty' },
                {
                  title: '不含税单价',
                  dataIndex: 'unitPrice',
                  render: (v: number | string) => '¥' + money(v),
                },
                {
                  title: '含税单价',
                  dataIndex: 'unitPriceInclTax',
                  render: (v: number | string | null) => (v != null ? '¥' + money(v) : '-'),
                },
                { title: '备注', dataIndex: 'note', render: (v: string | null) => v || '-' },
              ]}
            />
          </div>
        ) : (
          <div style={{ color: '#999' }}>无预览数据</div>
        )}
      </Modal>
    </div>
  )
}
