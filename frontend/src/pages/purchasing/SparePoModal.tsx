import { useEffect, useState } from 'react'
import { Alert, Button, Form, InputNumber, Modal, Select, Space, message } from 'antd'
import { PlusOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { api } from '../../api'
import { notifyError } from '../common'
import type { PartOption, SalesOrder, Supplier } from './types'

interface SpareFormValues {
  supplierId?: number
  salesOrderId?: number
  items?: { partId?: number; qty?: number | null }[]
}

interface Props {
  open: boolean
  canCreate: boolean
  suppliers: Supplier[]
  onCancel: () => void
  onSuccess: () => void
}

export default function SparePoModal(props: Props) {
  const { open, canCreate, suppliers, onCancel, onSuccess } = props
  const [form] = Form.useForm<SpareFormValues>()
  const [parts, setParts] = useState<PartOption[]>([])
  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    form.resetFields()
    form.setFieldsValue({ items: [{ qty: undefined }] })
    void Promise.all([api.get<PartOption[]>('/parts'), api.get<SalesOrder[]>('/orders')])
      .then(([p, o]) => {
        setParts(p.data)
        setOrders(o.data)
      })
      .catch(notifyError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function handleSubmit(values: SpareFormValues) {
    setSubmitting(true)
    try {
      const { data } = await api.post<{ orderNo?: string } | { orderNo?: string }[]>('/purchase-orders', {
        poType: 'spare',
        supplierId: values.supplierId,
        salesOrderId: values.salesOrderId ?? undefined,
        items: (values.items ?? []).map((it) => ({
          partId: Number(it.partId ?? 0),
          qty: Number(it.qty ?? 0),
          unitPrice: 0,
          unitPriceInclTax: 0,
          note: '请给3‰免费备品',
        })),
      })
      const orderNos = Array.isArray(data)
        ? data.map((o) => o.orderNo).join('、')
        : data?.orderNo ?? ''
      message.success('免费备品单已生成：' + (orderNos || '编号将自动生成为订单号+备品'))
      form.resetFields()
      onSuccess()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title="免费备品单"
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      width={720}
      destroyOnClose
    >
      {!canCreate ? (
        <Alert type="info" showIcon message="当前账号只读，无法新建免费备品单" />
      ) : (
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="单价强制 0，备注自动填写「请给3‰免费备品」，编号将自动生成为订单号+备品"
          />
          <Space wrap style={{ marginBottom: 8 }}>
            <Form.Item
              name="supplierId"
              label="供应商"
              rules={[{ required: true, message: '请选择供应商' }]}
              style={{ marginBottom: 8 }}
            >
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="选择供应商"
                style={{ width: 240 }}
                options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Form.Item>
            <Form.Item name="salesOrderId" label="关联订单（可选）" style={{ marginBottom: 8 }}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="选择销售订单"
                style={{ width: 240 }}
                options={orders.map((o) => ({
                  value: o.id,
                  label: o.orderNo + '（' + (o.customer?.name ?? '') + '）',
                }))}
              />
            </Form.Item>
          </Space>

          <Form.List name="items">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <div key={field.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
                    <Form.Item
                      name={[field.name, 'partId']}
                      rules={[{ required: true, message: '请选择零件' }]}
                      style={{ marginBottom: 0, width: 300 }}
                    >
                      <Select
                        showSearch
                        optionFilterProp="label"
                        placeholder="零件（SKU + 名称）"
                        options={parts.map((p) => ({
                          value: p.id,
                          label: p.sku + '　' + p.name,
                        }))}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'qty']}
                      rules={[{ required: true, message: '数量' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <InputNumber min={1} precision={0} placeholder="数量" />
                    </Form.Item>
                    <Button
                      type="text"
                      danger
                      icon={<MinusCircleOutlined />}
                      onClick={() => remove(field.name)}
                      disabled={fields.length === 1}
                    />
                  </div>
                ))}
                <Button type="dashed" onClick={() => add({ qty: undefined })} block icon={<PlusOutlined />}>
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
