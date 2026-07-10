import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

@Injectable()
export class PrismaService extends PrismaClient
  implements OnModuleInit, OnModuleDestroy {

  constructor() {
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
    })
    const adapter = new PrismaPg(pool)
    super({ adapter } as any)
  }

  async onModuleInit() {
    await this.$connect()
    console.log('Database connected')
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}