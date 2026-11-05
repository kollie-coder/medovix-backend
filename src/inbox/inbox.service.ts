import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

// Only these notification types belong in the doctor's results inbox.
const INBOX_TYPES = ['lab', 'prescription', 'referral']

@Injectable()
export class InboxService {
  constructor(private prisma: PrismaService) {}

  async list(userId: string, hospitalId: string, filter: 'unread' | 'all', page = 1) {
    const where = { userId, type: { in: INBOX_TYPES }, ...(filter === 'unread' ? { read: false } : {}) }
    const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
    const pageSize = 30

    const [total, rows] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * pageSize,
        take: pageSize,
        select: { id: true, title: true, body: true, type: true, data: true, read: true, createdAt: true },
      }),
    ])

    // The notification only stores ids. Look up which visit and patient each
    // one is about so the portal can link straight to it.
    const labIds: string[] = []
    const rxIds: string[] = []
    const apptIds: string[] = []
    for (const r of rows) {
      const d = (r.data ?? {}) as Record<string, string | undefined>
      if (d.labOrderId) labIds.push(d.labOrderId)
      if (d.prescriptionId) rxIds.push(d.prescriptionId)
      if (d.appointmentId && !d.labOrderId && !d.prescriptionId) apptIds.push(d.appointmentId)
    }

    // An empty id list simply returns nothing, so no special casing is needed.
    const [labs, rxs, appts] = await Promise.all([
      this.prisma.labOrder.findMany({
        where: { id: { in: labIds }, hospitalId },
        select: { id: true, appointmentId: true, patient: { select: { id: true, firstName: true, lastName: true } } },
      }),
      this.prisma.prescription.findMany({
        where: { id: { in: rxIds }, record: { hospitalId } },
        select: { id: true, record: { select: { appointmentId: true, patient: { select: { id: true, firstName: true, lastName: true } } } } },
      }),
      this.prisma.appointment.findMany({
        where: { id: { in: apptIds }, hospitalId },
        select: { id: true, patient: { select: { id: true, firstName: true, lastName: true } } },
      }),
    ])
    const labMap = new Map<string, (typeof labs)[number]>()
    for (const l of labs) labMap.set(l.id, l)
    const rxMap = new Map<string, (typeof rxs)[number]>()
    for (const p of rxs) rxMap.set(p.id, p)
    const apptMap = new Map<string, (typeof appts)[number]>()
    for (const a of appts) apptMap.set(a.id, a)

    const items = rows.map(r => {
      const d = (r.data ?? {}) as Record<string, string | undefined>
      const lab = d.labOrderId ? labMap.get(d.labOrderId) : undefined
      const rx = d.prescriptionId ? rxMap.get(d.prescriptionId) : undefined
      const appt = d.appointmentId ? apptMap.get(d.appointmentId) : undefined
      const patient = lab?.patient ?? rx?.record.patient ?? appt?.patient ?? null
      const appointmentId = lab?.appointmentId ?? rx?.record.appointmentId ?? appt?.id ?? null
      return {
        id: r.id,
        title: r.title,
        body: r.body,
        type: r.type,
        critical: r.title.startsWith('CRITICAL'),
        read: r.read,
        createdAt: r.createdAt,
        patient,
        appointmentId,
      }
    })

    return { page: safePage, pageSize, total, items }
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, type: { in: INBOX_TYPES }, read: false },
    })
    const critical = await this.prisma.notification.count({
      where: { userId, type: { in: INBOX_TYPES }, read: false, title: { startsWith: 'CRITICAL' } },
    })
    return { count, critical }
  }

  async markRead(userId: string, id: string) {
    const res = await this.prisma.notification.updateMany({
      where: { id, userId, type: { in: INBOX_TYPES } },
      data: { read: true },
    })
    if (res.count === 0) throw new NotFoundException('Notification not found')
    return { id, read: true }
  }

  async markAllRead(userId: string) {
    const res = await this.prisma.notification.updateMany({
      where: { userId, type: { in: INBOX_TYPES }, read: false },
      data: { read: true },
    })
    return { updated: res.count }
  }
}
