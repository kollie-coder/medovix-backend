import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { LabOrderStatus, Prisma, RecordType } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { CancelOrderDto, CorrectionDto, EnterResultDto, ResultFlag } from './lab.dto'
import { auditMeta } from '../common/request-context'

const OPEN_STATUSES: LabOrderStatus[] = [
  LabOrderStatus.REQUESTED,
  LabOrderStatus.SAMPLE_COLLECTED,
  LabOrderStatus.IN_PROGRESS,
]

const LIST_SELECT = {
  id: true,
  testName: true,
  priority: true,
  status: true,
  clinicalNotes: true,
  cancelReason: true,
  sampleCollectedAt: true,
  completedAt: true,
  createdAt: true,
  patient: { select: { id: true, firstName: true, lastName: true, gender: true, dateOfBirth: true } },
  orderedBy: { select: { id: true, firstName: true, lastName: true } },
  resultRecord: { select: { labResult: { select: { overallStatus: true, impression: true, results: true } } } },
} satisfies Prisma.LabOrderSelect

@Injectable()
export class LabService {
  private readonly logger = new Logger(LabService.name)

  constructor(private prisma: PrismaService) {}

  private async audit(hospitalId: string, userId: string, action: string, entityId: string, after?: Record<string, any>) {
    try {
      await this.prisma.auditLog.create({
        data: { hospitalId, userId, action, entity: 'LabOrder', entityId, after: after ?? undefined, ...auditMeta() },
      })
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${(err as Error).message}`)
    }
  }

  /** Best-effort notification; a failure here never blocks lab work. */
  private async notify(userId: string, title: string, body: string, type: string, data?: Record<string, any>) {
    try {
      await this.prisma.notification.create({ data: { userId, title, body, type, data: data ?? undefined } })
    } catch (err) {
      this.logger.error(`Failed to create notification: ${(err as Error).message}`)
    }
  }

  private async findOrder(hospitalId: string, id: string) {
    const order = await this.prisma.labOrder.findFirst({
      where: { id, hospitalId },
      select: {
        id: true, status: true, testName: true, patientId: true, orderedById: true, appointmentId: true,
        orderedBy: { select: { firstName: true, lastName: true } },
      },
    })
    if (!order) throw new NotFoundException('Lab request not found')
    return order
  }

  // ── Worklist ────────────────────────────────────────────

  /** `open` (default) = not finished; or COMPLETED / CANCELLED, most recent 100. */
  async list(hospitalId: string, view?: string) {
    const finished = view === 'COMPLETED' || view === 'CANCELLED'
    const orders = await this.prisma.labOrder.findMany({
      where: {
        hospitalId,
        status: finished ? (view as LabOrderStatus) : { in: OPEN_STATUSES },
      },
      select: LIST_SELECT,
      orderBy: finished ? { updatedAt: 'desc' } : [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 100,
    })

    const registrations = await this.prisma.hospitalPatient.findMany({
      where: { hospitalId, patientId: { in: orders.map((o) => o.patient.id) } },
      select: { patientId: true, patientNumber: true },
    })
    const numberOf = new Map(registrations.map((r) => [r.patientId, r.patientNumber]))
    return orders.map((o) => ({ ...o, patientNumber: numberOf.get(o.patient.id) ?? null }))
  }

  // ── Steps ───────────────────────────────────────────────

  /** A conditional update, so two people clicking at once cannot both win. */
  private async move(
    hospitalId: string, actorId: string, id: string,
    from: LabOrderStatus[], data: Prisma.LabOrderUncheckedUpdateManyInput, action: string,
  ) {
    const order = await this.findOrder(hospitalId, id)
    if (!from.includes(order.status)) {
      throw new BadRequestException(`This request is ${order.status.replace('_', ' ').toLowerCase()}, so it cannot ${action}`)
    }
    const result = await this.prisma.labOrder.updateMany({
      where: { id, hospitalId, status: { in: from } },
      data,
    })
    if (result.count === 0) throw new ConflictException('Someone else just changed this request. Refresh and try again.')
    return order
  }

  async collectSample(hospitalId: string, actorId: string, id: string) {
    await this.move(hospitalId, actorId, id, [LabOrderStatus.REQUESTED],
      { status: LabOrderStatus.SAMPLE_COLLECTED, sampleCollectedAt: new Date() }, 'have a sample collected')
    await this.audit(hospitalId, actorId, 'UPDATE', id, { status: LabOrderStatus.SAMPLE_COLLECTED })
    return { id, status: LabOrderStatus.SAMPLE_COLLECTED }
  }

  async start(hospitalId: string, actorId: string, id: string) {
    await this.move(hospitalId, actorId, id, [LabOrderStatus.SAMPLE_COLLECTED],
      { status: LabOrderStatus.IN_PROGRESS, performedById: actorId }, 'be started')
    await this.audit(hospitalId, actorId, 'UPDATE', id, { status: LabOrderStatus.IN_PROGRESS })
    return { id, status: LabOrderStatus.IN_PROGRESS }
  }

  async cancel(hospitalId: string, actorId: string, id: string, dto: CancelOrderDto) {
    const reason = dto.reason.trim()
    const order = await this.move(hospitalId, actorId, id, OPEN_STATUSES,
      { status: LabOrderStatus.CANCELLED, cancelledAt: new Date(), cancelReason: reason }, 'be cancelled')
    await this.audit(hospitalId, actorId, 'UPDATE', id, { status: LabOrderStatus.CANCELLED, reason })
    await this.notify(
      order.orderedById,
      'Lab request cancelled',
      `${order.testName} was cancelled by the lab: ${reason}`,
      'lab',
      { labOrderId: id },
    )
    return { id, status: LabOrderStatus.CANCELLED }
  }

  // ── Results ─────────────────────────────────────────────

  private overall(results: { flag: ResultFlag }[]) {
    if (results.some((r) => r.flag === ResultFlag.CRITICAL)) return 'CRITICAL'
    if (results.some((r) => r.flag === ResultFlag.HIGH || r.flag === ResultFlag.LOW)) return 'ABNORMAL'
    return 'NORMAL'
  }

  /** Saves the result as a medical record and closes the request, all or nothing. */
  async enterResult(hospitalId: string, actorId: string, id: string, dto: EnterResultDto) {
    const order = await this.findOrder(hospitalId, id)
    const allowed: LabOrderStatus[] = [LabOrderStatus.SAMPLE_COLLECTED, LabOrderStatus.IN_PROGRESS]
    if (!allowed.includes(order.status)) {
      throw new BadRequestException(
        order.status === LabOrderStatus.REQUESTED
          ? 'Record that the sample was collected before entering results'
          : `This request is ${order.status.replace('_', ' ').toLowerCase()}, so results cannot be entered`,
      )
    }

    const results = dto.results.map((r) => ({
      parameter: r.parameter.trim(),
      value: r.value.trim(),
      unit: r.unit?.trim() || null,
      range: r.range?.trim() || null,
      flag: r.flag,
    }))
    const overallStatus = this.overall(results)
    const impression = dto.impression?.trim() || undefined
    const requestedBy = `Dr ${order.orderedBy.firstName} ${order.orderedBy.lastName}`

    const record = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.labOrder.updateMany({
        where: { id, hospitalId, status: { in: allowed }, resultRecordId: null },
        data: { status: LabOrderStatus.COMPLETED, completedAt: new Date(), performedById: actorId },
      })
      if (claimed.count === 0) {
        throw new ConflictException('Someone else just changed this request. Refresh and try again.')
      }
      const created = await tx.medicalRecord.create({
        data: {
          hospitalId,
          patientId: order.patientId,
          appointmentId: order.appointmentId,
          createdById: actorId,
          type: RecordType.LAB_RESULT,
          title: `Lab result: ${order.testName}`,
          summary: overallStatus === 'NORMAL' ? 'Normal' : overallStatus === 'CRITICAL' ? 'Critical result' : 'Abnormal result',
          labResult: {
            create: { testName: order.testName, requestedBy, overallStatus, impression, results },
          },
        },
        select: { id: true },
      })
      await tx.labOrder.update({ where: { id }, data: { resultRecordId: created.id } })
      return created
    })

    await this.audit(hospitalId, actorId, 'UPDATE', id, {
      status: LabOrderStatus.COMPLETED, recordId: record.id, overallStatus,
    })

    // The requesting doctor hears about it; critical results are flagged as such.
    await this.notify(
      order.orderedById,
      overallStatus === 'CRITICAL' ? 'CRITICAL lab result' : 'Lab result ready',
      `${order.testName}: ${overallStatus.toLowerCase()}`,
      'lab',
      { labOrderId: id, recordId: record.id, overallStatus },
    )
    await this.notify(
      order.patientId,
      'Your lab result is ready',
      `${order.testName} results are now available.`,
      'lab',
      { recordId: record.id },
    )
    return { id, status: LabOrderStatus.COMPLETED, recordId: record.id, overallStatus }
  }

  /** Completed results are never edited. A correction is a new, clearly labelled record. */
  async addCorrection(hospitalId: string, actorId: string, id: string, dto: CorrectionDto) {
    const order = await this.findOrder(hospitalId, id)
    if (order.status !== LabOrderStatus.COMPLETED) {
      throw new BadRequestException('Only a completed result can have a correction')
    }
    const note = dto.note.trim()
    const record = await this.prisma.medicalRecord.create({
      data: {
        hospitalId,
        patientId: order.patientId,
        appointmentId: order.appointmentId,
        createdById: actorId,
        type: RecordType.LAB_RESULT,
        title: `Correction: ${order.testName}`,
        summary: note.slice(0, 200),
        labResult: {
          create: {
            testName: order.testName,
            requestedBy: `Dr ${order.orderedBy.firstName} ${order.orderedBy.lastName}`,
            overallStatus: 'CORRECTION',
            impression: note,
            results: [],
          },
        },
      },
      select: { id: true },
    })
    await this.audit(hospitalId, actorId, 'CREATE', id, { correctionRecordId: record.id })
    await this.notify(
      order.orderedById,
      'Lab result corrected',
      `A correction was added to ${order.testName}.`,
      'lab',
      { labOrderId: id, recordId: record.id },
    )
    return record
  }
}
