import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { randomInt } from 'crypto'
import { AppointmentStatus, ClinicalDocumentType, Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { ReferralDto, SickNoteDto } from './documents.dto'
import { auditMeta } from '../common/request-context'

// No 0/O or 1/I/L, so a reference read aloud or copied by hand is not mistaken.
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const DAY_MS = 24 * 60 * 60 * 1000

function newReference() {
  let out = ''
  for (let i = 0; i < 8; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)]
  return `MD-${out.slice(0, 4)}-${out.slice(4)}`
}

function dateOnly(value: string) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date')
  return d
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name)

  constructor(private prisma: PrismaService) {}

  private async audit(hospitalId: string, userId: string, action: string, entity: string, entityId: string, after?: Record<string, any>) {
    try {
      await this.prisma.auditLog.create({ data: { hospitalId, userId, action, entity, entityId, after: after ?? undefined, ...auditMeta() } })
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${(err as Error).message}`)
    }
  }

  /** The doctor's own appointment, open or finished. Letters cannot be written for a visit that has not started. */
  private async ownVisit(hospitalId: string, id: string, doctorId: string) {
    const a = await this.prisma.appointment.findFirst({
      where: { id, hospitalId, doctorId, deletedAt: null },
      select: { id: true, status: true, patientId: true },
    })
    if (!a) throw new NotFoundException('Appointment not found')
    if (a.status !== AppointmentStatus.IN_PROGRESS && a.status !== AppointmentStatus.COMPLETED) {
      throw new BadRequestException('Start the consultation before writing a letter')
    }
    return a
  }

  private async create(
    hospitalId: string, doctorId: string, appointment: { id: string; patientId: string },
    type: ClinicalDocumentType, content: Prisma.InputJsonObject,
  ) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const doc = await this.prisma.clinicalDocument.create({
          data: {
            reference: newReference(),
            type, hospitalId, patientId: appointment.patientId, authorId: doctorId,
            appointmentId: appointment.id, content,
          },
          select: { id: true, reference: true, type: true, createdAt: true },
        })
        await this.audit(hospitalId, doctorId, 'CREATE', 'ClinicalDocument', doc.id, { type, reference: doc.reference })
        return doc
      } catch (err) {
        // Unique clash on the reference: pick another one.
        if ((err as { code?: string }).code === 'P2002') continue
        throw err
      }
    }
    throw new BadRequestException('Could not create the document, please try again')
  }

  async createSickNote(hospitalId: string, doctorId: string, appointmentId: string, dto: SickNoteDto) {
    const appointment = await this.ownVisit(hospitalId, appointmentId, doctorId)
    const start = dateOnly(dto.startDate)
    const end = dateOnly(dto.endDate)
    if (end.getTime() < start.getTime()) throw new BadRequestException('The end date cannot be before the start date')
    const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1
    if (days > 90) throw new BadRequestException('A sick note can cover at most 90 days. Issue another one to extend it.')
    if (start.getTime() < Date.now() - 14 * DAY_MS) throw new BadRequestException('A sick note cannot start more than 14 days in the past')

    const showDiagnosis = !!dto.includeDiagnosis && !!dto.diagnosis?.trim()
    return this.create(hospitalId, doctorId, appointment, ClinicalDocumentType.SICK_NOTE, {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      days,
      diagnosis: showDiagnosis ? dto.diagnosis!.trim() : null,
      remarks: dto.remarks?.trim() || null,
    })
  }

  async createReferral(hospitalId: string, doctorId: string, appointmentId: string, dto: ReferralDto) {
    const appointment = await this.ownVisit(hospitalId, appointmentId, doctorId)
    return this.create(hospitalId, doctorId, appointment, ClinicalDocumentType.REFERRAL, {
      referredTo: dto.referredTo.trim(),
      department: dto.department?.trim() || null,
      urgency: dto.urgency,
      reason: dto.reason.trim(),
      clinicalSummary: dto.clinicalSummary.trim(),
      currentMedication: dto.currentMedication?.trim() || null,
    })
  }

  async listForVisit(hospitalId: string, doctorId: string, appointmentId: string) {
    await this.ownVisit(hospitalId, appointmentId, doctorId)
    return this.prisma.clinicalDocument.findMany({
      where: { hospitalId, appointmentId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, reference: true, type: true, content: true, createdAt: true },
    })
  }

  private readonly hospitalSelect = {
    name: true, address: true, city: true, state: true, phone: true, email: true, website: true, logo: true,
  } satisfies Prisma.HospitalSelect

  // Printed under the signature: pharmacies and employers look for the licence number.
  private readonly authorSelect = {
    firstName: true,
    lastName: true,
    staffProfile: { select: { specialization: true, licenseNumber: true } },
  } satisfies Prisma.UserSelect

  private async patientNumber(hospitalId: string, patientId: string) {
    const reg = await this.prisma.hospitalPatient.findUnique({
      where: { hospitalId_patientId: { hospitalId, patientId } },
      select: { patientNumber: true },
    })
    return reg?.patientNumber ?? null
  }

  /** Everything the print page needs for a sick note or referral. */
  async getPrintable(hospitalId: string, doctorId: string, id: string) {
    const doc = await this.prisma.clinicalDocument.findFirst({
      where: { id, hospitalId },
      select: {
        id: true, reference: true, type: true, content: true, createdAt: true, patientId: true,
        hospital: { select: this.hospitalSelect },
        patient: { select: { firstName: true, lastName: true, dateOfBirth: true, gender: true } },
        author: { select: this.authorSelect },
      },
    })
    if (!doc) throw new NotFoundException('Document not found')
    await this.audit(hospitalId, doctorId, 'PRINT', 'ClinicalDocument', doc.id, { reference: doc.reference })
    const { patientId, ...rest } = doc
    return { ...rest, patientNumber: await this.patientNumber(hospitalId, patientId) }
  }

  async getPrescriptionPrintable(hospitalId: string, doctorId: string, prescriptionId: string) {
    const rx = await this.prisma.prescription.findFirst({
      where: { id: prescriptionId, record: { hospitalId } },
      select: {
        id: true, status: true, expiryDate: true, refillsAllowed: true, refillsUsed: true, notes: true, createdAt: true,
        medications: { select: { name: true, dosage: true, frequency: true, duration: true, instructions: true } },
        record: {
          select: {
            id: true, patientId: true,
            hospital: { select: this.hospitalSelect },
            patient: { select: { firstName: true, lastName: true, dateOfBirth: true, gender: true } },
            createdBy: { select: this.authorSelect },
          },
        },
      },
    })
    if (!rx) throw new NotFoundException('Prescription not found')
    await this.audit(hospitalId, doctorId, 'PRINT', 'Prescription', rx.id)
    const { record, ...rest } = rx
    return {
      ...rest,
      hospital: record.hospital,
      patient: record.patient,
      author: record.createdBy,
      patientNumber: await this.patientNumber(hospitalId, record.patientId),
    }
  }

  /** All prescriptions written during one visit, for a single combined printout. */
  async getVisitPrescriptionsPrintable(hospitalId: string, doctorId: string, appointmentId: string) {
    const appt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, hospitalId, deletedAt: null },
      select: {
        id: true, patientId: true,
        doctor: { select: this.authorSelect },
        patient: { select: { firstName: true, lastName: true, dateOfBirth: true, gender: true } },
        hospital: { select: this.hospitalSelect },
      },
    })
    if (!appt) throw new NotFoundException('Appointment not found')

    const records = await this.prisma.medicalRecord.findMany({
      where: { hospitalId, appointmentId, type: 'PRESCRIPTION', deletedAt: null, prescription: { isNot: null } },
      orderBy: { createdAt: 'asc' },
      select: {
        prescription: {
          select: {
            id: true, status: true, expiryDate: true, refillsAllowed: true, refillsUsed: true, notes: true, createdAt: true,
            medications: { select: { name: true, dosage: true, frequency: true, duration: true, instructions: true } },
          },
        },
      },
    })
    // Declined prescriptions are not given to the patient.
    const prescriptions = records.flatMap((r) => (r.prescription && r.prescription.status !== 'CANCELLED' ? [r.prescription] : []))
    if (prescriptions.length === 0) throw new NotFoundException('There are no active prescriptions for this visit')

    await this.audit(hospitalId, doctorId, 'PRINT', 'Appointment', appt.id, { what: 'prescriptions', count: prescriptions.length })
    return {
      hospital: appt.hospital,
      patient: appt.patient,
      author: appt.doctor,
      patientNumber: await this.patientNumber(hospitalId, appt.patientId),
      prescriptions,
    }
  }

  /**
   * Public check of a printed letter. Gives away only what someone holding the
   * paper already knows: the kind of letter, who issued it, when, and the
   * dates it covers. The patient is shown as initials.
   */
  async verify(rawReference: string) {
    const reference = (rawReference ?? '').trim().toUpperCase()
    if (!/^MD-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(reference)) return { valid: false as const }
    const doc = await this.prisma.clinicalDocument.findUnique({
      where: { reference },
      select: {
        type: true, content: true, createdAt: true,
        hospital: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        author: { select: { firstName: true, lastName: true } },
      },
    })
    if (!doc) return { valid: false as const }
    const c = (doc.content ?? {}) as Record<string, unknown>
    return {
      valid: true as const,
      type: doc.type,
      hospital: doc.hospital.name,
      issuedAt: doc.createdAt,
      issuedBy: `Dr ${doc.author.firstName} ${doc.author.lastName}`,
      patientInitials: `${doc.patient.firstName.charAt(0)}.${doc.patient.lastName.charAt(0)}.`.toUpperCase(),
      ...(doc.type === ClinicalDocumentType.SICK_NOTE
        ? { startDate: c.startDate ?? null, endDate: c.endDate ?? null }
        : {}),
    }
  }
}
