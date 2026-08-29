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
  product: { sku: string; name: string }
}

export interface SalesOrderDetail extends SalesOrder {
  deliveryDate: string
  items: SalesOrderDetailItem[]
}

export interface Supplier {
  id: number
  name: string
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
}

export interface PoFormValues {
  orderNo?: string
  orderDate?: string
  expectedDeliveryDate?: string
  paymentTerms?: string
  termsNote?: string
  headerName?: string
  taxPoint?: number | null
  manualOrderNo?: string
  items?: PoItemField[]
}

export interface PurchaseOrderItem {
  id: number
  partId: number
  sku: string
  name: string
  unit: string
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
