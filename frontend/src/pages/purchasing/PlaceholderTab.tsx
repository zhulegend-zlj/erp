import { Card, Empty } from 'antd'

export default function PlaceholderTab({ title }: { title: string }) {
  return (
    <Card size="small">
      <Empty description={title + '（第二期上线）'} />
    </Card>
  )
}
