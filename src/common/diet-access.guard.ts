import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { canUseDietLogging } from './entitlements'

@Injectable()
export class DietAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest()
    const userId: string | undefined = req.user?.id
    if (!userId) return false

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, planExpiresAt: true, createdAt: true },
    })
    if (!user) return false

    if (!canUseDietLogging(user)) {
      throw new ForbiddenException({
        message: 'Diet logging is a Premium feature',
        code: 'PREMIUM_REQUIRED',
      })
    }
    return true
  }
}