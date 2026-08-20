import type { FastifyInstance } from 'fastify'
import { buildApp } from '../server'

export function createTestApp(): FastifyInstance {
  return buildApp()
}
