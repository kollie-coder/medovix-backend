import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common'
import { AppointmentStatus, BillItemType, BillStatus, PaymentKind, Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import {
  CreateInvoiceDto, CreatePriceDto, MAX_KOBO, PaymentDto, UpdatePriceDto,
} from './billing.dto'
import { auditMeta } from '../common/request-context'

const DAY_MS = 24 * 60 * 60 * 1000
const UNPAID: BillStatus[] = [BillStatus.PENDING, BillStatus.PARTIAL]
const PAGE_SIZE = 25

/** What the screens show: a part-paid or unpaid invoice past its due date is overdue. */
function effectiveStatus(status: BillStatus, dueDate: Date) {
  return UNPAID.includes(status) && dueDate.getTime() < Date.now() ? BillStatus.OVERDUE : status
}

function parseDate(value: string, label: string) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${label}`)
  return d
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name)

  constructor(private prisma: PrismaService) {}

  // ── Helpers ─────────────────────────────────────────────

  private async audit(hospitalId: string, userId: string, action: string, entity: string, entityId: string, after?: Record<string, any>) {
    try {
      await this.prisma.auditLog.create({ data: { hospitalId, userId, action, entity, entityId, after: after ?? undefined, ...auditMeta() } })
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${(err as Error).message}`)
    }
  }

  private async notify(userId: string, title: string, body: string, data?: Record<string, any>) {
    try {
      await this.prisma.notification.create({ data: { userId, title, body, type: 'bill', data: data ?? undefined } })
    } catch (err) {
      this.logger.error(`Failed to create notification: ${(err as Error).message}`)
    }
  }

  private naira(kobo: number) {
    return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  /** Serialises changes to one invoice so two payments cannot both pass the balance check. */
  private lock(tx: Prisma.TransactionClient, billId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${billId}))`
  }

  private async patientNumbers(hospitalId: string, patientIds: string[]) {
    if (patientIds.length === 0) return new Map<string, string>()
    const regs = await this.prisma.hospitalPatient.findMany({
      where: { hospitalId, patientId: { in: patientIds } },
      select: { patientId: true, patientNumber: true },
    })
    return new Map(regs.map((r) => [r.patientId, r.patientNumber]))
  }

  private async nextInvoiceNo(hospitalId: string, attempt: number) {
    const hospital = await this.prisma.hospital.findUnique({ where: { id: hospitalId }, select: { name: true } })
    const prefix = (hospital?.name ?? 'HOS').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X')
    const year = new Date().getFullYear()
    const count = await this.prisma.bill.count({
      where: { hospitalId, createdAt: { gte: new Date(year, 0, 1) } },
    })
    return `INV-${prefix}-${year}-${String(count + 1 + attempt).padStart(6, '0')}`
  }

  private async findBill(hospitalId: string, id: string) {
    const bill = await this.prisma.bill.findFirst({
      where: { id, hospitalId, deletedAt: null },
      select: { id: true },
    })
    if (!bill) throw new NotFoundException('Invoice not found')
    return bill
  }

  // ── Invoices ────────────────────────────────────────────

  async list(hospitalId: string, filter: string, search: string | undefined, page = 1) {
    const where: Prisma.BillWhereInput = { hospitalId, deletedAt: null }
    const now = new Date()
    if (filter === 'unpaid') where.status = { in: UNPAID }
    else if (filter === 'overdue') { where.status = { in: UNPAID }; where.dueDate = { lt: now } }
    else if (filter === 'paid') where.status = BillStatus.PAID
    else if (filter === 'cancelled') where.status = BillStatus.CANCELLED
    const q = search?.trim()
    if (q) {
      where.OR = [
        { invoiceNo: { contains: q, mode: 'insensitive' } },
        { patient: { firstName: { contains: q, mode: 'insensitive' } } },
        { patient: { lastName: { contains: q, mode: 'insensitive' } } },
      ]
    }
    const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
    const [total, rows] = await Promise.all([
      this.prisma.bill.count({ where }),
      this.prisma.bill.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * PAGE_SIZE, take: PAGE_SIZE,
        select: {
          id: true, invoiceNo: true, status: true, totalAmount: true, amountPaid: true, dueDate: true, createdAt: true,
          patient: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
    ])
    const numbers = await this.patientNumbers(hospitalId, rows.map((r) => r.patient.id))
    return {
      page: safePage, pageSize: PAGE_SIZE, total,
      items: rows.map((r) => ({
        ...r,
        status: effectiveStatus(r.status, r.dueDate),
        balance: r.status === BillStatus.CANCELLED ? 0 : r.totalAmount - r.amountPaid,
        patientNumber: numbers.get(r.patient.id) ?? null,
      })),
    }
  }

  async get(hospitalId: string, id: string) {
    const bill = await this.prisma.bill.findFirst({
      where: { id, hospitalId, deletedAt: null },
      select: {
        id: true, invoiceNo: true, status: true, totalAmount: true, amountPaid: true, dueDate: true, paidAt: true,
        cancelReason: true, cancelledAt: true, notes: true, createdAt: true, appointmentId: true,
        patient: { select: { id: true, firstName: true, lastName: true, phone: true } },
        createdBy: { select: { firstName: true, lastName: true } },
        items: { orderBy: { createdAt: 'asc' }, select: { id: true, type: true, name: true, quantity: true, unitPrice: true, total: true } },
        payments: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true, amount: true, method: true, reference: true, kind: true, reversesId: true, note: true, paidAt: true,
            recordedBy: { select: { firstName: true, lastName: true } },
            reversedBy: { select: { id: true } },
          },
        },
      },
    })
    if (!bill) throw new NotFoundException('Invoice not found')
    const numbers = await this.patientNumbers(hospitalId, [bill.patient.id])
    return {
      ...bill,
      status: effectiveStatus(bill.status, bill.dueDate),
      balance: bill.status === BillStatus.CANCELLED ? 0 : bill.totalAmount - bill.amountPaid,
      patientNumber: numbers.get(bill.patient.id) ?? null,
      payments: bill.payments.map(({ reversedBy, ...p }) => ({ ...p, reversed: !!reversedBy })),
    }
  }

  async create(hospitalId: string, userId: string, dto: CreateInvoiceDto) {
    const registered = await this.prisma.hospitalPatient.findUnique({
      where: { hospitalId_patientId: { hospitalId, patientId: dto.patientId } },
      select: { patientId: true },
    })
    if (!registered) throw new NotFoundException('Patient not found at this hospital')

    if (dto.appointmentId) {
      const appt = await this.prisma.appointment.findFirst({
        where: { id: dto.appointmentId, hospitalId, patientId: dto.patientId, deletedAt: null },
        select: { id: true },
      })
      if (!appt) throw new BadRequestException('That visit does not belong to this patient')
      const existing = await this.prisma.bill.findFirst({
        where: { appointmentId: dto.appointmentId, deletedAt: null, status: { not: BillStatus.CANCELLED } },
        select: { invoiceNo: true },
      })
      if (existing) throw new ConflictException(`An invoice already exists for this visit (${existing.invoiceNo})`)
    }

    const items = dto.items.map((i) => ({ ...i, name: i.name.trim(), total: i.quantity * i.unitPrice }))
    if (items.some((i) => !i.name)) throw new BadRequestException('Every line needs a name')
    const total = items.reduce((sum, i) => sum + i.total, 0)
    if (total <= 0) throw new BadRequestException('The invoice total must be more than zero')
    if (total > MAX_KOBO) throw new BadRequestException(`An invoice cannot exceed ${this.naira(MAX_KOBO)}`)

    const dueDate = dto.dueDate ? parseDate(dto.dueDate, 'due date') : new Date(Date.now() + 14 * DAY_MS)

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const bill = await this.prisma.bill.create({
          data: {
            hospitalId, patientId: dto.patientId, appointmentId: dto.appointmentId, createdById: userId,
            invoiceNo: await this.nextInvoiceNo(hospitalId, attempt),
            totalAmount: total, dueDate, notes: dto.notes?.trim() || undefined,
            items: { create: items },
          },
          select: { id: true, invoiceNo: true, totalAmount: true },
        })
        await this.audit(hospitalId, userId, 'CREATE', 'Bill', bill.id, { invoiceNo: bill.invoiceNo, total, items: items.length })
        await this.notify(dto.patientId, 'New invoice', `Invoice ${bill.invoiceNo} for ${this.naira(total)} has been issued.`, { billId: bill.id })
        return bill
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') continue // invoice number taken, try the next one
        throw err
      }
    }
    throw new ConflictException('Could not allocate an invoice number, please try again')
  }

  async recordPayment(hospitalId: string, userId: string, billId: string, dto: PaymentDto) {
    await this.findBill(hospitalId, billId)
    if (dto.method !== 'CASH' && !dto.reference?.trim()) {
      throw new BadRequestException('Enter the transfer, card or POS reference')
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, billId)
      const bill = await tx.bill.findUnique({
        where: { id: billId },
        select: { id: true, invoiceNo: true, patientId: true, status: true, totalAmount: true, amountPaid: true },
      })
      if (!bill) throw new NotFoundException('Invoice not found')
      if (bill.status === BillStatus.CANCELLED) throw new BadRequestException('This invoice has been cancelled')
      const balance = bill.totalAmount - bill.amountPaid
      if (balance <= 0) throw new BadRequestException('This invoice is already fully paid')
      if (dto.amount > balance) throw new BadRequestException(`The payment is more than the balance of ${this.naira(balance)}`)

      const payment = await tx.payment.create({
        data: {
          billId, amount: dto.amount, method: dto.method, reference: dto.reference?.trim() || undefined,
          note: dto.note?.trim() || undefined, kind: PaymentKind.PAYMENT, recordedById: userId,
        },
        select: { id: true, amount: true, method: true, paidAt: true },
      })
      const paid = bill.amountPaid + dto.amount
      const settled = paid >= bill.totalAmount
      await tx.bill.update({
        where: { id: billId },
        data: { amountPaid: paid, status: settled ? BillStatus.PAID : BillStatus.PARTIAL, paidAt: settled ? new Date() : null },
      })
      return { payment, bill, paid, settled }
    })

    await this.audit(hospitalId, userId, 'CREATE', 'Payment', result.payment.id, {
      billId, invoiceNo: result.bill.invoiceNo, amount: dto.amount, method: dto.method,
    })
    await this.notify(
      result.bill.patientId, 'Payment received',
      `${this.naira(dto.amount)} received for invoice ${result.bill.invoiceNo}.${result.settled ? ' It is now fully paid.' : ''}`,
      { billId },
    )
    return { id: result.payment.id, amountPaid: result.paid, balance: result.bill.totalAmount - result.paid, settled: result.settled }
  }

  /** Payments are never edited or deleted. A mistake is undone by a reversal entry. */
  async reversePayment(hospitalId: string, userId: string, billId: string, paymentId: string, reason: string) {
    await this.findBill(hospitalId, billId)
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, billId)
      const payment = await tx.payment.findFirst({
        where: { id: paymentId, billId },
        select: { id: true, amount: true, method: true, kind: true, reference: true },
      })
      if (!payment) throw new NotFoundException('Payment not found')
      if (payment.kind !== PaymentKind.PAYMENT) throw new BadRequestException('A reversal cannot be reversed')
      const already = await tx.payment.findFirst({ where: { reversesId: paymentId }, select: { id: true } })
      if (already) throw new ConflictException('This payment has already been reversed')

      const bill = await tx.bill.findUnique({
        where: { id: billId },
        select: { invoiceNo: true, totalAmount: true, amountPaid: true, patientId: true },
      })
      if (!bill) throw new NotFoundException('Invoice not found')

      const reversal = await tx.payment.create({
        data: {
          billId, amount: -payment.amount, method: payment.method, reference: payment.reference ?? undefined,
          kind: PaymentKind.REVERSAL, reversesId: payment.id, note: reason.trim(), recordedById: userId,
        },
        select: { id: true },
      })
      const paid = bill.amountPaid - payment.amount
      await tx.bill.update({
        where: { id: billId },
        data: {
          amountPaid: paid,
          status: paid <= 0 ? BillStatus.PENDING : paid >= bill.totalAmount ? BillStatus.PAID : BillStatus.PARTIAL,
          paidAt: paid >= bill.totalAmount ? new Date() : null,
        },
      })
      return { reversal, payment, bill, paid }
    })

    await this.audit(hospitalId, userId, 'CREATE', 'Payment', result.reversal.id, {
      billId, invoiceNo: result.bill.invoiceNo, reverses: paymentId, amount: -result.payment.amount, reason: reason.trim(),
    })
    return { id: result.reversal.id, amountPaid: result.paid, balance: result.bill.totalAmount - result.paid }
  }

  async cancel(hospitalId: string, userId: string, billId: string, reason: string) {
    await this.findBill(hospitalId, billId)
    const bill = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, billId)
      const b = await tx.bill.findUnique({ where: { id: billId }, select: { invoiceNo: true, status: true, amountPaid: true } })
      if (!b) throw new NotFoundException('Invoice not found')
      if (b.status === BillStatus.CANCELLED) throw new BadRequestException('This invoice is already cancelled')
      if (b.amountPaid !== 0) throw new BadRequestException('Reverse the payments on this invoice before cancelling it')
      await tx.bill.update({
        where: { id: billId },
        data: { status: BillStatus.CANCELLED, cancelReason: reason.trim(), cancelledAt: new Date() },
      })
      return b
    })
    await this.audit(hospitalId, userId, 'UPDATE', 'Bill', billId, { invoiceNo: bill.invoiceNo, cancelled: true, reason: reason.trim() })
    return { id: billId, status: BillStatus.CANCELLED }
  }

  // ── Money in, money owed ────────────────────────────────

  async summary(hospitalId: string, from: string, to: string) {
    const start = parseDate(from, 'start')
    const end = parseDate(to, 'end')
    if (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > 93 * DAY_MS) {
      throw new BadRequestException('Choose a range of up to 93 days')
    }
    const range = { bill: { hospitalId }, paidAt: { gte: start, lt: end } }
    const [byMethod, collected, reversed, owed, overdue] = await Promise.all([
      this.prisma.payment.groupBy({ by: ['method'], where: range, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.payment.aggregate({ where: { ...range, kind: PaymentKind.PAYMENT }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.payment.aggregate({ where: { ...range, kind: PaymentKind.REVERSAL }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.bill.aggregate({
        where: { hospitalId, deletedAt: null, status: { in: UNPAID } },
        _sum: { totalAmount: true, amountPaid: true }, _count: { _all: true },
      }),
      this.prisma.bill.aggregate({
        where: { hospitalId, deletedAt: null, status: { in: UNPAID }, dueDate: { lt: new Date() } },
        _sum: { totalAmount: true, amountPaid: true }, _count: { _all: true },
      }),
    ])
    const collectedKobo = collected._sum.amount ?? 0
    const reversedKobo = Math.abs(reversed._sum.amount ?? 0)
    return {
      from: start, to: end,
      collected: collectedKobo,
      reversed: reversedKobo,
      net: collectedKobo - reversedKobo,
      paymentCount: collected._count._all,
      byMethod: byMethod
        .map((m) => ({ method: m.method, net: m._sum.amount ?? 0, entries: m._count._all }))
        .sort((a, b) => b.net - a.net),
      outstanding: {
        count: owed._count._all,
        amount: (owed._sum.totalAmount ?? 0) - (owed._sum.amountPaid ?? 0),
      },
      overdue: {
        count: overdue._count._all,
        amount: (overdue._sum.totalAmount ?? 0) - (overdue._sum.amountPaid ?? 0),
      },
    }
  }

  /** Finished visits in the last 30 days that nobody has invoiced yet. */
  async unbilled(hospitalId: string) {
    const rows = await this.prisma.appointment.findMany({
      where: {
        hospitalId, deletedAt: null, status: AppointmentStatus.COMPLETED,
        completedAt: { gte: new Date(Date.now() - 30 * DAY_MS) },
        bills: { none: { deletedAt: null, status: { not: BillStatus.CANCELLED } } },
      },
      orderBy: { completedAt: 'desc' },
      take: 50,
      select: {
        id: true, completedAt: true, reason: true,
        patient: { select: { id: true, firstName: true, lastName: true } },
        doctor: { select: { firstName: true, lastName: true } },
      },
    })
    const numbers = await this.patientNumbers(hospitalId, rows.map((r) => r.patient.id))
    return rows.map((r) => ({ ...r, patientNumber: numbers.get(r.patient.id) ?? null }))
  }

  /** Invoice lines drawn from what happened in the visit, priced from the price list. */
  async suggestions(hospitalId: string, appointmentId: string) {
    const appt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, hospitalId, deletedAt: null },
      select: {
        id: true, patientId: true,
        patient: { select: { firstName: true, lastName: true } },
        doctor: { select: { firstName: true, lastName: true, staffProfile: { select: { consultationFee: true } } } },
        labOrders: { where: { status: { not: 'CANCELLED' } }, select: { testName: true } },
        records: {
          where: { type: 'PRESCRIPTION', deletedAt: null },
          select: { prescription: { select: { status: true, medications: { select: { name: true } } } } },
        },
        bills: { where: { deletedAt: null, status: { not: BillStatus.CANCELLED } }, select: { id: true, invoiceNo: true } },
      },
    })
    if (!appt) throw new NotFoundException('Visit not found')

    const prices = await this.prisma.priceItem.findMany({
      where: { hospitalId, active: true },
      select: { type: true, name: true, price: true },
    })
    const lookup = (type: BillItemType, name: string) =>
      prices.find((p) => p.type === type && p.name.trim().toLowerCase() === name.trim().toLowerCase())?.price ?? null

    const fee = appt.doctor.staffProfile?.consultationFee
    const consultationName = `Consultation: Dr ${appt.doctor.firstName} ${appt.doctor.lastName}`
    const lines: { type: BillItemType; name: string; quantity: number; unitPrice: number | null }[] = [
      {
        type: BillItemType.CONSULTATION, name: consultationName, quantity: 1,
        unitPrice: fee && fee > 0 ? Math.round(fee * 100) : lookup(BillItemType.CONSULTATION, 'Consultation'),
      },
    ]
    for (const l of appt.labOrders) {
      lines.push({ type: BillItemType.LAB, name: l.testName, quantity: 1, unitPrice: lookup(BillItemType.LAB, l.testName) })
    }
    for (const r of appt.records) {
      if (!r.prescription || r.prescription.status === 'CANCELLED') continue
      for (const m of r.prescription.medications) {
        lines.push({ type: BillItemType.PHARMACY, name: m.name, quantity: 1, unitPrice: lookup(BillItemType.PHARMACY, m.name) })
      }
    }
    return {
      appointmentId: appt.id,
      patientId: appt.patientId,
      patientName: `${appt.patient.firstName} ${appt.patient.lastName}`,
      existingInvoice: appt.bills[0] ?? null,
      lines,
    }
  }

  /** Registered patients, name and number only, for choosing who to invoice. */
  async searchPatients(hospitalId: string, search: string) {
    const q = search.trim()
    if (q.length < 2) return []
    const rows = await this.prisma.hospitalPatient.findMany({
      where: {
        hospitalId,
        OR: [
          { patientNumber: { contains: q, mode: 'insensitive' } },
          { patient: { firstName: { contains: q, mode: 'insensitive' } } },
          { patient: { lastName: { contains: q, mode: 'insensitive' } } },
        ],
      },
      take: 10,
      select: { patientNumber: true, patient: { select: { id: true, firstName: true, lastName: true } } },
    })
    return rows.map((r) => ({ id: r.patient.id, name: `${r.patient.firstName} ${r.patient.lastName}`, patientNumber: r.patientNumber }))
  }

  // ── Price list ──────────────────────────────────────────

  listPrices(hospitalId: string) {
    return this.prisma.priceItem.findMany({
      where: { hospitalId },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      select: { id: true, type: true, name: true, price: true, active: true },
    })
  }

  async createPrice(hospitalId: string, userId: string, dto: CreatePriceDto) {
    const name = dto.name.trim()
    const dupe = await this.prisma.priceItem.findFirst({
      where: { hospitalId, type: dto.type, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    })
    if (dupe) throw new ConflictException('That item is already on the price list')
    const item = await this.prisma.priceItem.create({
      data: { hospitalId, type: dto.type, name, price: dto.price },
      select: { id: true, type: true, name: true, price: true, active: true },
    })
    await this.audit(hospitalId, userId, 'CREATE', 'PriceItem', item.id, { name, price: dto.price, type: dto.type })
    return item
  }

  async updatePrice(hospitalId: string, userId: string, id: string, dto: UpdatePriceDto) {
    const existing = await this.prisma.priceItem.findFirst({ where: { id, hospitalId }, select: { id: true, name: true, price: true, active: true } })
    if (!existing) throw new NotFoundException('Price not found')
    const data: Prisma.PriceItemUpdateInput = {}
    if (dto.name !== undefined) data.name = dto.name.trim()
    if (dto.price !== undefined) data.price = dto.price
    if (dto.active !== undefined) data.active = dto.active
    const item = await this.prisma.priceItem.update({ where: { id }, data, select: { id: true, type: true, name: true, price: true, active: true } })
    await this.audit(hospitalId, userId, 'UPDATE', 'PriceItem', id, { before: existing, after: dto })
    return item
  }

  // ── Print ───────────────────────────────────────────────

  private readonly hospitalSelect = {
    name: true, address: true, city: true, state: true, phone: true, email: true, website: true, logo: true,
  } satisfies Prisma.HospitalSelect

  async invoicePrintable(hospitalId: string, userId: string, id: string) {
    await this.findBill(hospitalId, id)
    const [bill, hospital] = await Promise.all([
      this.get(hospitalId, id),
      this.prisma.hospital.findUniqueOrThrow({ where: { id: hospitalId }, select: this.hospitalSelect }),
    ])
    await this.audit(hospitalId, userId, 'PRINT', 'Bill', id, { invoiceNo: bill.invoiceNo })
    return { hospital, bill }
  }

  async receiptPrintable(hospitalId: string, userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, bill: { hospitalId, deletedAt: null } },
      select: {
        id: true, amount: true, method: true, reference: true, kind: true, paidAt: true, billId: true,
        recordedBy: { select: { firstName: true, lastName: true } },
      },
    })
    if (!payment) throw new NotFoundException('Payment not found')
    if (payment.kind !== PaymentKind.PAYMENT) throw new BadRequestException('A receipt can only be printed for a payment')
    const [bill, hospital] = await Promise.all([
      this.get(hospitalId, payment.billId),
      this.prisma.hospital.findUniqueOrThrow({ where: { id: hospitalId }, select: this.hospitalSelect }),
    ])
    await this.audit(hospitalId, userId, 'PRINT', 'Payment', payment.id, { invoiceNo: bill.invoiceNo })
    return {
      hospital,
      payment,
      invoice: {
        invoiceNo: bill.invoiceNo, totalAmount: bill.totalAmount, amountPaid: bill.amountPaid, balance: bill.balance,
        patient: bill.patient, patientNumber: bill.patientNumber,
      },
    }
  }
}
