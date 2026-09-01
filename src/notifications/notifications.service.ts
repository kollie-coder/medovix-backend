import { Injectable, NotFoundException, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(private prisma: PrismaService) {}

  // ── Get paginated notification feed for the current user ────
  async findAll(userId: string, query: { page?: string; limit?: string }) {
    const page = parseInt(query.page ?? '1')
    const limit = parseInt(query.limit ?? '20')
    const skip = (page - 1) * limit

    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.notification.count({ where: { userId, read: false } }),
    ])

    return {
      data: notifications,
      unreadCount,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }
  }

  // ── Get just the unread count (for the badge on the bell icon) ──
  async getUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, read: false },
    })
    return { unreadCount: count }
  }

  // ── Mark a single notification as read ───────────────────────
  async markAsRead(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    })

    if (!notification) throw new NotFoundException('Notification not found')

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { read: true },
    })
  }

  // ── Mark all as read ──────────────────────────────────────────
  async markAllAsRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    })
    return { message: 'All notifications marked as read' }
  }

  // ── Delete a single notification ─────────────────────────────
  async remove(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    })

    if (!notification) throw new NotFoundException('Notification not found')

    await this.prisma.notification.delete({ where: { id: notificationId } })
    return { message: 'Notification deleted' }
  }

  // ── Internal helper: create a notification ───────────────────
  // Called from elsewhere in the app (reminders, dietary reminders,
  // health tips scheduler etc.) whenever something notification-worthy
  // happens, so it shows up in the user's inbox — not just as a push.
  async create(userId: string, dto: {
    title: string
    body: string
    type: string
    data?: any
  }) {
    return this.prisma.notification.create({
      data: {
        userId,
        title: dto.title,
        body: dto.body,
        type: dto.type,
        data: dto.data,
        status: 'SENT',
        sentAt: new Date(),
      },
    })
  }
}