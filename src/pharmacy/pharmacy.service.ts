import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma, PrescriptionStatus } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { DeclineDto, DispenseDto } from './pharmacy.dto'
import { auditMeta } from '../common/request-context'

const SELECT = {
  id: true,
  status: true,
  expiryDate: true,
  refillsAllowed: true,
  refillsUsed: true,
  notes: true,
  dispensedAt: true,
  createdAt: true,
  medications: { select: { name: true, dosage: true, frequency: true, duration: true, instructions: true } },
  dispensedBy: { select: { firstName: true, lastName: true } },
  record: {
    select: {
      id: true,
      createdAt: true,
      patient: {
        select: {
          id: true, firstName: true, lastName: true, gender: true, dateOfBirth: true,
          patientProfile: { select: { allergies: true } },
        },
      },
      createdBy: { select: { id: true, firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.PrescriptionSelect

@Injectable()
export class PharmacyService {
  private readonly logger = new Logger(PharmacyService.name)

  constructor(private prisma: PrismaService) {}

  private async audit(hospitalId: string, userId: string, action: string, entityId: string, after?: Record<string, any>) {
    try {
      await this.prisma.auditLog.create({
        data: { hospitalId, userId, action, entity: 'Prescription', entityId, after: after ?? undefined, ...auditMeta() },
      })
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${(err as Error).message}`)
    }
  }

  private async notify(userId: string, title: string, body: string, data?: Record<string, any>) {
    try {
      await this.prisma.notification.create({ data: { userId, title, body, type: 'prescription', data: data ?? undefined } })
    } catch (err) {
      this.logger.error(`Failed to create notification: ${(err as Error).message}`)
    }
  }

  /** Allergy words that appear in a medication name, or the other way round. */
  private allergyMatches(allergies: string[], medicationNames: string[]) {
    const matches: { medication: string; allergy: string }[] = []
    for (const med of medicationNames) {
      const m = med.toLowerCase()
      for (const a of allergies) {
        const al = a.trim().toLowerCase()
        if (al.length < 3) continue
        if (m.includes(al) || (m.length >= 3 && al.includes(m))) matches.push({ medication: med, allergy: a })
      }
    }
    return matches
  }

  private decorate<T extends {
    medications: { name: string }[]
    expiryDate: Date | null
    refillsAllowed: number
    refillsUsed: number
    dispensedAt: Date | null
    record: { patient: { patientProfile: { allergies: string[] } | null } }
  }>(p: T) {
    const allergies = p.record.patient.patientProfile?.allergies ?? []
    return {
      ...p,
      allergies,
      allergyMatches: this.allergyMatches(allergies, p.medications.map((m) => m.name)),
      expired: !!p.expiryDate && p.expiryDate.getTime() < Date.now(),
      // First supply, or a refill that is still available.
      supplyAvailable: p.dispensedAt === null || p.refillsUsed < p.refillsAllowed,
    }
  }

  // ── Queue ───────────────────────────────────────────────

  /** `to-dispense` (default), `dispensed` or `declined`; most recent 100. */
  async list(hospitalId: string, view?: string) {
    const status: PrescriptionStatus =
      view === 'dispensed' ? PrescriptionStatus.DISPENSED
      : view === 'declined' ? PrescriptionStatus.CANCELLED
      : PrescriptionStatus.ACTIVE

    const rows = await this.prisma.prescription.findMany({
      where: { status, record: { hospitalId, deletedAt: null } },
      select: SELECT,
      orderBy: status === PrescriptionStatus.ACTIVE ? { createdAt: 'asc' } : { createdAt: 'desc' },
      take: 100,
    })

    const registrations = await this.prisma.hospitalPatient.findMany({
      where: { hospitalId, patientId: { in: rows.map((r) => r.record.patient.id) } },
      select: { patientId: true, patientNumber: true },
    })
    const numberOf = new Map(registrations.map((r) => [r.patientId, r.patientNumber]))
    return rows.map((r) => ({ ...this.decorate(r), patientNumber: numberOf.get(r.record.patient.id) ?? null }))
  }

  private async find(hospitalId: string, id: string) {
    const p = await this.prisma.prescription.findFirst({
      where: { id, record: { hospitalId, deletedAt: null } },
      select: SELECT,
    })
    if (!p) throw new NotFoundException('Prescription not found')
    return p
  }

  // ── Dispense ────────────────────────────────────────────

  /**
   * First dispense hands over the initial supply. Each later dispense uses up
   * one refill. When nothing is left the prescription is marked DISPENSED.
   */
  async dispense(hospitalId: string, pharmacistId: string, id: string, dto: DispenseDto) {
    const p = await this.find(hospitalId, id)
    const view = this.decorate(p)

    if (p.status !== PrescriptionStatus.ACTIVE) {
      throw new BadRequestException(`This prescription is ${p.status.toLowerCase()} and cannot be dispensed`)
    }
    if (view.expired) throw new BadRequestException('This prescription has expired. Ask the doctor to issue a new one.')
    if (!view.supplyAvailable) throw new BadRequestException('No refills are left on this prescription')

    if (view.allergyMatches.length > 0 && !dto.confirmAllergyOverride) {
      throw new ConflictException({
        statusCode: 409,
        code: 'ALLERGY_WARNING',
        message: 'This patient has a recorded allergy that matches a medication on this prescription.',
        matches: view.allergyMatches,
      })
    }

    const isRefill = p.dispensedAt !== null
    const refillsUsed = p.refillsUsed + (isRefill ? 1 : 0)
    const finished = refillsUsed >= p.refillsAllowed

    // Matches only if nobody else dispensed in the meantime.
    const claimed = await this.prisma.prescription.updateMany({
      where: { id, status: PrescriptionStatus.ACTIVE, refillsUsed: p.refillsUsed, dispensedAt: p.dispensedAt },
      data: {
        dispensedAt: new Date(),
        dispensedById: pharmacistId,
        refillsUsed,
        status: finished ? PrescriptionStatus.DISPENSED : PrescriptionStatus.ACTIVE,
      },
    })
    if (claimed.count === 0) {
      throw new ConflictException('Someone else just dispensed this prescription. Refresh and check.')
    }

    await this.audit(hospitalId, pharmacistId, 'UPDATE', id, {
      action: isRefill ? 'refill' : 'dispense',
      refillsUsed,
      finished,
      ...(view.allergyMatches.length > 0 && { allergyOverride: true, allergyMatches: view.allergyMatches }),
    })
    await this.notify(
      p.record.patient.id,
      'Medication dispensed',
      'Your prescription has been dispensed by the pharmacy.',
      { prescriptionId: id },
    )
    return { id, status: finished ? PrescriptionStatus.DISPENSED : PrescriptionStatus.ACTIVE, refillsUsed }
  }

  async decline(hospitalId: string, pharmacistId: string, id: string, dto: DeclineDto) {
    const p = await this.find(hospitalId, id)
    if (p.status !== PrescriptionStatus.ACTIVE) {
      throw new BadRequestException(`This prescription is ${p.status.toLowerCase()} and cannot be declined`)
    }
    if (p.dispensedAt !== null) {
      throw new BadRequestException('Part of this prescription was already dispensed, so it cannot be declined')
    }

    const reason = dto.reason.trim()
    const note = `${p.notes ? p.notes + '\n' : ''}[Pharmacy declined: ${reason}]`
    const claimed = await this.prisma.prescription.updateMany({
      where: { id, status: PrescriptionStatus.ACTIVE, dispensedAt: null },
      data: { status: PrescriptionStatus.CANCELLED, notes: note },
    })
    if (claimed.count === 0) {
      throw new ConflictException('Someone else just changed this prescription. Refresh and check.')
    }

    await this.audit(hospitalId, pharmacistId, 'UPDATE', id, { status: PrescriptionStatus.CANCELLED, reason })
    await this.notify(
      p.record.createdBy.id,
      'Prescription declined by pharmacy',
      `${p.record.patient.firstName} ${p.record.patient.lastName}: ${reason}`,
      { prescriptionId: id },
    )
    return { id, status: PrescriptionStatus.CANCELLED }
  }
}
