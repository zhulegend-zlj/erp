export interface SalesOrder {
  id: number
  orderNo: string
  status: string
  purchasing?: boolean
  producing?: boolean
  customer?: { name: string }
}

export interface SalesOrderDetailItem {
  id: number
  productId: number
  qty: number
  unitPrice?: string
  customerDeliveryDate?: string | null
  zrhDeliveryDate?: string | null
  product: { sku: string; name: string }
}

export interface SalesOrderDetail extends SalesOrder {
  deliveryDate: string
  items: SalesOrderDetailItem[]
}

export interface Supplier {
  id: number
  name: string
  shortName?: string | null
  contact?: string | null
  contactPerson?: string | null
  phone?: string | null
  fax?: string | null
  email?: string | null
  defaultPaymentTerms?: string | null
  defaultHeaderName?: string | null
  taxPoint?: number | null
}

export interface Requirement {
  partId: number
  sku: string
  partName: string
  supplierId: number | null
  supplierName: string
  price: number | null
  priceInclTax?: number | null
  moq?: number | null
  leadTime?: string | null
  safetyStock?: number | null
  isCommonPart?: boolean
  usage: number | null
  usageText?: string
  requiredQty: number
  onHand: number
  gapQty: number
  suggestedQty: number
  // 采购方式（2026-09-01）：外购总进采购单；自购库存不足带入；自制不进
  sourcing: 'purchased' | 'selfbuy' | 'selfmade'
  isSelfBuy: boolean
  includeInPo: boolean
  excluded: boolean
  excludedReason: string
}

export interface SplitField {
  qty?: number | null
  expectedDeliveryDate?: string | null
}

export interface PoItemField {
  partId?: number
  qty?: number | null
  unitPrice?: number | null
  unitPriceInclTax?: number | null
  supplierId?: number | null
  usage?: number | null
  note?: string
  supplierReplyDate?: string | null
  splits?: SplitField[]
  // 自购件：归入「自购」采购单（不出给供应商）
  selfBuy?: boolean
}

export interface PoFormValues {
  orderNo?: string
  orderDate?: string
  expectedDeliveryDate?: string
  paymentTerms?: string
  termsNote?: string
  headerName?: string
  items?: PoItemField[]
  templateId?: number
}

export interface PurchaseOrderItem {
  id: number
  partId: number
  sku: string
  name: string
  unit: string
  sourcing?: 'purchased' | 'selfbuy' | 'selfmade'
  qty: number
  usage?: number | null
  note?: string | null
  supplierReplyDate?: string | null
  unitPrice: number | string
  unitPriceInclTax?: number | string | null
}

export interface PurchaseOrder {
  id: number
  orderNo: string
  status: string
  poStatus: string
  poType: string
  orderDate?: string | null
  expectedDeliveryDate?: string | null
  paymentTerms?: string | null
  termsNote?: string | null
  headerName?: string | null
  taxPoint?: number | null
  supplierId?: number
  supplierName: string
  salesOrderNo?: string
  salesOrders?: { id: number; orderNo: string }[]
  totalAmount: number | string
  paidAmount: number | string
  outstanding: number | string
  orderedQty: number
  receivedQty: number
  createdAt: string
  items?: PurchaseOrderItem[]
}

export interface CompanyHeader {
  id: number
  name: string
  address?: string | null
  tel?: string | null
  fax?: string | null
  email?: string | null
}

export interface PoAttachment {
  id: number
  url: string
  name?: string | null
  uploadedAt?: string
}

export interface PoPreviewLine {
  sku: string
  name: string
  spec?: string | null
  material?: string | null
  finish?: string | null
  unit?: string | null
  usage?: number | string | null
  qty: number
  unitPrice: number | string
  unitPriceInclTax?: number | string | null
  note?: string | null
  sourcing?: string | null
}

export interface PoPreview {
  headerName?: string | null
  orderNo: string
  orderDate?: string | null
  supplier?: {
    name?: string | null
    contactPerson?: string | null
    phone?: string | null
    fax?: string | null
    email?: string | null
  } | null
  model?: string | null
  paymentTerms?: string | null
  expectedDeliveryDate?: string | null
  taxPoint?: number | null
  lines?: PoPreviewLine[]
}

export interface PartOption {
  id: number
  sku: string
  name: string
  unit?: string
}

// 采购跟进（2026-09-09）：一行 = 一个采购单明细行
export interface FollowUpRow {
  id: number
  purchaseOrderId: number
  purchaseOrderNo: string
  poStatus: string
  poType: string
  receiveStatus: string
  headerName?: string | null
  supplierId: number
  supplierName: string
  salesOrderId: number | null
  salesOrderNo: string
  salesOrderNos: string[]
  productModel: string
  productName: string
  orderQty: number | null
  partId: number
  sku: string
  partName: string
  spec?: string | null
  unit?: string | null
  usage?: number | null
  qty: number
  unitPrice?: number
  unitPriceInclTax?: number | null
  amount?: number
  orderDate?: string | null
  expectedDeliveryDate?: string | null
  supplierReplyDate?: string | null
  lastDeliveryDate?: string | null
  receivedQty: number
  returnQty: number
  replenishQty: number
  outstandingQty: number
  confirmed: boolean
  deliveryConfirmedAt?: string | null
  done: boolean
}

export interface DeliveryEditLogRow {
  id: number
  field: string
  beforeVal?: string | null
  afterVal?: string | null
  editedBy: string
  editedAt: string
  note?: string | null
}
