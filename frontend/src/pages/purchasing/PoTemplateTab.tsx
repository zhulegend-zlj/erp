import { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal, Popconfirm, Radio, Select, Space, Spin, Table, Tag, Upload, message } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { api } from '../../api'
import { notifyError } from '../common'
import TemplateEditor from './TemplateEditor'
import type { TmplModel } from './TemplateEditor'

interface PoTemplateRow {
  id: number
  name: string
  headerType: 'zrh' | 'jmc'
  isDefault: boolean
  config?: { version?: number; model?: TmplModel } | null
}

interface SupplierOption {
  id: number
  name: string
  shortName?: string | null
  poTemplateId?: number | null
}

export default function PoTemplateTab(props: { canCreate: boolean }) {
  const { canCreate } = props
  const [rows, setRows] = useState<PoTemplateRow[]>([])
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [startMode, setStartMode] = useState<'builtin' | 'upload'>('builtin')
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<'zrh' | 'jmc'>('zrh')
  const uploadRef = useRef<{ file: File | null }>({ file: null })

  const [editingRow, setEditingRow] = useState<PoTemplateRow | null>(null)
  const [editModel, setEditModel] = useState<TmplModel | null>(null)
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [t, s] = await Promise.all([api.get<PoTemplateRow[]>('/po-templates'), api.get<SupplierOption[]>('/suppliers')])
      setRows(t.data)
      setSuppliers(s.data)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleCreate() {
    if (!newName.trim()) {
      message.error('请输入模板名')
      return
    }
    setCreating(true)
    try {
      let model: TmplModel
      if (startMode === 'upload') {
        if (!uploadRef.current.file) {
          message.error('请选择要上传的 xlsx 表格')
          setCreating(false)
          return
        }
        const fd = new FormData()
        fd.append('file', uploadRef.current.file)
        const { data } = await api.post<{ model: TmplModel }>('/po-templates/parse-xlsx', fd)
        model = data.model
      } else {
        const { data } = await api.get<{ model: TmplModel }>('/po-templates/default-model', { params: { headerType: newType } })
        model = data.model
      }
      const { data: created } = await api.post<PoTemplateRow>('/po-templates', {
        name: newName.trim(),
        headerType: newType,
        isDefault: false,
        config: { version: 2, model },
      })
      message.success('模板已创建，请在 A4 画布上调整后点保存')
      setCreateOpen(false)
      setNewName('')
      uploadRef.current.file = null
      setEditingRow(created)
      setEditModel(JSON.parse(JSON.stringify(model)))
      void load()
    } catch (err) {
      notifyError(err)
    } finally {
      setCreating(false)
    }
  }

  function openEditor(row: PoTemplateRow) {
    const cfg = row.config ?? {}
    if (cfg.version === 2 && cfg.model) {
      setEditingRow(row)
      setEditModel(JSON.parse(JSON.stringify(cfg.model)))
      return
    }
    void api
      .get<{ model: TmplModel }>('/po-templates/default-model', { params: { headerType: row.headerType } })
      .then(({ data }) => {
        setEditingRow(row)
        setEditModel(data.model)
      })
      .catch(notifyError)
  }

  async function saveModel() {
    if (!editingRow || !editModel) return
    setSaving(true)
    try {
      await api.patch('/po-templates/' + editingRow.id, { config: { version: 2, model: editModel } })
      message.success('模板已保存：预览、打印和导出都用这份模板')
      setEditingRow(null)
      setEditModel(null)
      void load()
    } catch (err) {
      notifyError(err)
    } finally {
      setSaving(false)
    }
  }

  async function setDefault(row: PoTemplateRow) {
    try {
      await api.patch('/po-templates/' + row.id, { isDefault: true })
      message.success('已设为默认模板')
      void load()
    } catch (err) {
      notifyError(err)
    }
  }

  async function bindSupplier(row: PoTemplateRow, supplierId: number | null) {
    try {
      await api.post('/po-templates/' + row.id + '/bind', { supplierId })
      message.success(supplierId ? '已绑定：该供应商生成采购单默认用此模板' : '已解绑')
      void load()
    } catch (err) {
      notifyError(err)
    }
  }

  async function remove(row: PoTemplateRow) {
    try {
      await api.delete('/po-templates/' + row.id)
      message.success('模板已删除')
      void load()
    } catch (err) {
      notifyError(err)
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        {canCreate ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建模板
          </Button>
        ) : null}
        <Tag color="blue">
          使用：上传表格或从系统模板起步 → 在 A4 画布上直接调整（改字/调宽高/合并/插行列）→ 保存 → 绑定供应商，生成采购单自动用
        </Tag>
      </Space>
      <Table<PoTemplateRow>
        sticky={{ offsetHeader: 8 }}
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: '模板名', dataIndex: 'name' },
          {
            title: '类型',
            dataIndex: 'headerType',
            width: 150,
            render: (v: string) => (v === 'zrh' ? <Tag color="blue">智锐恒（含税）</Tag> : <Tag color="green">锦名诚（不含税）</Tag>),
          },
          {
            title: '默认',
            dataIndex: 'isDefault',
            width: 90,
            render: (v: boolean, r: PoTemplateRow) =>
              v ? (
                <Tag color="gold">默认</Tag>
              ) : canCreate ? (
                <a onClick={() => void setDefault(r)}>设为默认</a>
              ) : (
                '-'
              ),
          },
          {
            title: '绑定供应商（生成采购单默认使用）',
            width: 320,
            render: (_: unknown, r: PoTemplateRow) => {
              const bound = suppliers.filter((s) => s.poTemplateId === r.id)
              return (
                <Select
                  mode="multiple"
                  allowClear
                  placeholder="选择供应商绑定此模板"
                  style={{ width: 300 }}
                  value={bound.map((s) => s.id)}
                  onChange={(ids: number[]) => {
                    const added = ids.find((i) => !bound.some((b) => b.id === i))
                    const removed = bound.find((b) => !ids.includes(b.id))
                    if (added != null) void bindSupplier(r, added)
                    if (removed != null) void bindSupplier(r, null)
                  }}
                  options={suppliers.map((s) => ({ value: s.id, label: s.shortName ? s.shortName + ' ' + s.name : s.name }))}
                />
              )
            },
          },
          {
            title: '操作',
            width: 220,
            render: (_: unknown, r: PoTemplateRow) =>
              canCreate ? (
                <Space>
                  <Button size="small" type="primary" ghost icon={<EditOutlined />} onClick={() => openEditor(r)}>
                    编辑模板
                  </Button>
                  <Popconfirm title={'确认删除模板「' + r.name + '」？'} onConfirm={() => void remove(r)}>
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ) : null,
          },
        ]}
      />

      <Modal
        title="新建打印模板"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
        confirmLoading={creating}
        destroyOnClose
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Space wrap>
            <span>模板名：</span>
            <Input style={{ width: 200 }} placeholder="如：信杰采购单模板" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Select
              style={{ width: 170 }}
              value={newType}
              onChange={setNewType}
              options={[
                { value: 'zrh', label: '智锐恒（含税）' },
                { value: 'jmc', label: '锦名诚（不含税）' },
              ]}
            />
          </Space>
          <Radio.Group value={startMode} onChange={(e) => setStartMode(e.target.value)}>
            <Radio value="builtin">从系统内置模板起步（推荐）</Radio>
            <Radio value="upload">上传我自己的表格（xlsx）</Radio>
          </Radio.Group>
          {startMode === 'upload' ? (
            <Upload
              accept=".xlsx,.xls,.csv"
              maxCount={1}
              beforeUpload={(file) => {
                uploadRef.current.file = file
                return false
              }}
              onRemove={() => {
                uploadRef.current.file = null
              }}
            >
              <Button>选择 xlsx 表格</Button>
            </Upload>
          ) : null}
          <div style={{ color: '#8c8c8c', fontSize: 12 }}>
            上传的表格将被解析成 A4 模板（格子/合并/宽高/文字都会保留），创建后可在画布上继续调整。
          </div>
        </div>
      </Modal>

      <Modal
        title={'模板编辑：' + (editingRow?.name ?? '') + '（一张 A4，像表格一样直接调）'}
        open={editingRow !== null && editModel !== null}
        onCancel={() => {
          setEditingRow(null)
          setEditModel(null)
        }}
        width={1240}
        maskClosable={false}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setEditingRow(null)
              setEditModel(null)
            }}
          >
            取消
          </Button>,
          <Button key="save" type="primary" loading={saving} onClick={() => void saveModel()}>
            保存模板
          </Button>,
        ]}
      >
        {editModel ? <TemplateEditor model={editModel} onChange={(m) => setEditModel(m)} /> : <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>}
      </Modal>
    </div>
  )
}
