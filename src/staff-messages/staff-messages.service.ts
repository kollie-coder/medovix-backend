import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, Role } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { auditMeta } from '../common/request-context'
import { MAX_MESSAGE_LENGTH } from './staff-messages.dto'

// Staff who work with patients on a visit. Admins and accountants have no need
// to send or read clinical messages, so they are left out.
export const MESSAGING_ROLES: Role[] = [
  Role.DOCTOR,
  Role.NURSE,
  Role.LAB_TECHNICIAN,
  Role.PHARMACIST,
  Role.RECEPTIONIST,
]

const PAGE_SIZE = 20
// Stops one person flooding another colleague.
const MAX_TO_ONE_PERSON_PER_HOUR = 30

const MESSAGE_SELECT = {
  id: true,
  body: true,
  createdAt: true,
  readAt: true,
  replyToId: true,
  sender: { select: { id: true, firstName: true, lastName: true, role: true } },
  recipient: { select: { id: true, firstName: true, lastName: true, role: true } },
  appointment: {
    select: {
      id: true,
      scheduledAt: true,
      patient: { select: { firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.StaffMessageSelect

// Short notes between colleagues about a patient's visit. Messages are never
// edited or deleted, never leave the hospital, and are never shown to patients.
@Injectable()
export class StaffMessagesService {
  private readonly logger = new Logger(StaffMessagesService.name)

  constructor(private prisma: PrismaService) {}

  // Postgres cannot store NUL characters, so they are removed before saving.
  private cleanBody(raw: string): string {
    const body = String(raw ?? '').replace(/\u0000/g, '').trim()
    if (!body) throw new BadRequestException('Write a message first')
    if (body.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException(`Messages can be up to ${MAX_MESSAGE_LENGTH} characters`)
    }
    return body
  }

  // The audit entry records who messaged whom about which visit, never the text,
  // because the text may contain clinical detail that administrators should not read.
  private async audit(hospitalId: string, userId: string, entityId: string, after: Record<string, unknown>) {
    try {
      await this.prisma.auditLog.create({
        data: {
          hospitalId,
          userId,
          action: 'CREATE',
          entity: 'StaffMessage',
          entityId,
          after: after as Prisma.InputJsonValue,
          ...auditMeta(),
        },
      })
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${(err as Error).message}`)
    }
  }

  // Active colleagues at the same hospital who can receive a message.
  recipients(userId: string, hospitalId: string) {
    return this.prisma.user.findMany({
      where: {
        hospitalId,
        role: { in: MESSAGING_ROLES },
        active: true,
        deletedAt: null,
        id: { not: userId },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        role: true,
        department: { select: { name: true } },
      },
      orderBy: [{ role: 'asc' }, { firstName: 'asc' }],
    })
  }

  private async assertActiveColleague(hospitalId: string, userId: string, recipientId: string) {
    if (recipientId === userId) throw new BadRequestException('You cannot message yourself')
    const recipient = await this.prisma.user.findFirst({
      where: {
        id: recipientId,
        hospitalId,
        role: { in: MESSAGING_ROLES },
        active: true,
        deletedAt: null,
      },
      select: { id: true },
    })
    if (!recipient) throw new NotFoundException('That colleague is not available')
  }

  private async assertNotFlooding(hospitalId: string, senderId: string, recipientId: string) {
    const recent = await this.prisma.staffMessage.count({
      where: {
        hospitalId,
        senderId,
        recipientId,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
    })
    if (recent >= MAX_TO_ONE_PERSON_PER_HOUR) {
      throw new HttpException(
        'You have sent a lot of messages to this colleague. Please wait a while before sending more.',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
  }

  // A doctor starts a conversation about one of their own visits.
  async create(
    senderId: string,
    senderRole: string,
    hospitalId: string,
    dto: { recipientId: string; appointmentId: string; body: string },
  ) {
    if (senderRole !== Role.DOCTOR) {
      throw new ForbiddenException('Only doctors can start a message from a visit. You can reply to messages you receive.')
    }
    const body = this.cleanBody(dto.body)

    const appointment = await this.prisma.appointment.findFirst({
      where: { id: dto.appointmentId, hospitalId, doctorId: senderId, deletedAt: null },
      select: { id: true },
    })
    if (!appointment) throw new NotFoundException('Visit not found')

    await this.assertActiveColleague(hospitalId, senderId, dto.recipientId)
    await this.assertNotFlooding(hospitalId, senderId, dto.recipientId)

    const message = await this.prisma.staffMessage.create({
      data: {
        hospitalId,
        senderId,
        recipientId: dto.recipientId,
        appointmentId: appointment.id,
        body,
      },
      select: MESSAGE_SELECT,
    })

    await this.audit(hospitalId, senderId, message.id, {
      recipientId: dto.recipientId,
      appointmentId: appointment.id,
      isReply: false,
    })
    return message
  }

  // Anyone who received a message can answer its sender, on the same visit.
  async reply(userId: string, hospitalId: string, messageId: string, rawBody: string) {
    const body = this.cleanBody(rawBody)

    const original = await this.prisma.staffMessage.findFirst({
      where: { id: messageId, hospitalId, recipientId: userId },
      select: { id: true, senderId: true, appointmentId: true },
    })
    if (!original) throw new NotFoundException('Message not found')

    await this.assertActiveColleague(hospitalId, userId, original.senderId)
    await this.assertNotFlooding(hospitalId, userId, original.senderId)

    const message = await this.prisma.staffMessage.create({
      data: {
        hospitalId,
        senderId: userId,
        recipientId: original.senderId,
        appointmentId: original.appointmentId,
        replyToId: original.id,
        body,
      },
      select: MESSAGE_SELECT,
    })

    // Answering a message counts as having read it.
    await this.prisma.staffMessage.updateMany({
      where: { id: original.id, readAt: null },
      data: { readAt: new Date() },
    })

    await this.audit(hospitalId, userId, message.id, {
      recipientId: original.senderId,
      appointmentId: original.appointmentId,
      isReply: true,
    })
    return message
  }

  async list(userId: string, hospitalId: string, box: 'inbox' | 'sent', page: number) {
    const where: Prisma.StaffMessageWhereInput =
      box === 'sent' ? { hospitalId, senderId: userId } : { hospitalId, recipientId: userId }
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1

    const [items, total] = await Promise.all([
      this.prisma.staffMessage.findMany({
        where,
        select: MESSAGE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.prisma.staffMessage.count({ where }),
    ])
    return { items, total, page: safePage, pageSize: PAGE_SIZE, hasMore: safePage * PAGE_SIZE < total }
  }

  // Everything you sent or received about one visit, oldest first.
  forAppointment(userId: string, hospitalId: string, appointmentId: string) {
    return this.prisma.staffMessage.findMany({
      where: {
        hospitalId,
        appointmentId,
        OR: [{ senderId: userId }, { recipientId: userId }],
      },
      select: MESSAGE_SELECT,
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
  }

  async unreadCount(userId: string, hospitalId: string) {
    const count = await this.prisma.staffMessage.count({
      where: { hospitalId, recipientId: userId, readAt: null },
    })
    return { count }
  }

  async markRead(userId: string, hospitalId: string, id: string) {
    const message = await this.prisma.staffMessage.findFirst({
      where: { id, hospitalId, recipientId: userId },
      select: { id: true },
    })
    if (!message) throw new NotFoundException('Message not found')
    await this.prisma.staffMessage.updateMany({
      where: { id, readAt: null },
      data: { readAt: new Date() },
    })
    return { read: true }
  }

  async markAllRead(userId: string, hospitalId: string) {
    const { count } = await this.prisma.staffMessage.updateMany({
      where: { hospitalId, recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    })
    return { marked: count }
  }
}
