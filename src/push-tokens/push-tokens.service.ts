// src/push-tokens/push-tokens.service.ts
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class PushTokensService {
  constructor(private prisma: PrismaService) {}

  // Register or update a push token
  async register(userId: string, token: string, platform: string) {
    // Upsert — if token exists update it, otherwise create
    return this.prisma.pushToken.upsert({
      where: { token },
      update: { userId, active: true, updatedAt: new Date() },
      create: { userId, token, platform, active: true },
    })
  }

  // Deactivate a push token (on logout)
  async remove(token: string) {
    await this.prisma.pushToken.updateMany({
      where: { token },
      data: { active: false },
    })
    return { message: 'Push token removed' }
  }

  // Get all active tokens for a user (used when sending notifications)
  async getActiveTokens(userId: string) {
    return this.prisma.pushToken.findMany({
      where: { userId, active: true },
      select: { token: true, platform: true },
    })
  }
}