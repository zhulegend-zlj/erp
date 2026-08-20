import jwt from 'jsonwebtoken'
import { config } from '../config'
export function signToken(user: { id: number; role: string }) {
  return jwt.sign({ userId: user.id, role: user.role }, config.jwtSecret, { expiresIn: '12h' })
}
export function verifyToken(token: string) {
  try {
    const p = jwt.verify(token, config.jwtSecret) as { userId: number; role: string }
    return { userId: p.userId, role: p.role }
  } catch { return null }
}
