import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common'
import { AppointmentStatus, AppointmentType, Prisma, RecordType, Role } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import {
  AddendumDto, ConsultationDto, LabOrdersDto, PrescriptionDto, VitalsDto,
} from './dto/clinical.dto'
import { auditMeta } from '../common/request-context'

const DUPLICATE_VIEW_WINDOW_MS = 10 * 60 * 1000

@Injectable()
export class ClinicalService {
  private readonly logger = new Logger(ClinicalService.name)

  constructor(private prisma: PrismaService) {}

  // ── Helpers ─────────────────────────────────────────────

  private async audit(params: {
    hospitalId: string
    userId: string
    action: string
    entity: string
    entityId: string
    after?: Record<string, any>
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          hospitalId: params.hospitalId,
          userId: params.userId,
          action: params.action,
          entity: params.entity,
          entityId: params.entityId,
          after: params.after ?? undefined,
          ...auditMeta(),
        },
      })
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${(err as Error).message}`)
    }
  }

  private dayRange(from?: string, to?: string) {
    const start = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0))
    const end = to ? new Date(to) : new Date(start.getTime() + 24 * 60 * 60 * 1000)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid date range')
    }
    return { start, end }
  }

  /** The doctor's own appointment in their own hospital, or 404. */
  private async ownAppointment(hospitalId: string, id: string, doctorId: string) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id, hospitalId, doctorId, deletedAt: null },
      select: { id: true, status: true, type: true, patientId: true, doctorId: true },
    })
    if (!appointment) throw new NotFoundException('Appointment not found')
    return appointment
  }

  private requireStatus(current: AppointmentStatus, allowed: AppointmentStatus[], action: string) {
    if (!allowed.includes(current)) {
      throw new BadRequestException(`Cannot ${action} while the appointment is ${current}`)
    }
  }

  private async withVitalsFlag<T extends { id: string }>(appointments: T[]) {
    if (appointments.length === 0) return [] as (T & { vitalsTaken: boolean })[]
    const records = await this.prisma.medicalRecord.findMany({
      where: {
        appointmentId: { in: appointments.map((a) => a.id) },
        type: RecordType.VITALS,
        deletedAt: null,
      },
      select: { appointmentId: true },
    })
    const done = new Set(records.map((r) => r.appointmentId))
    return appointments.map((a) => ({ ...a, vitalsTaken: done.has(a.id) }))
  }

  private async withPatientNumbers<T extends { patient: { id: string } }>(hospitalId: string, rows: T[]) {
    const registrations = await this.prisma.hospitalPatient.findMany({
      where: { hospitalId, patientId: { in: rows.map((r) => r.patient.id) } },
      select: { patientId: true, patientNumber: true },
    })
    const numberOf = new Map(registrations.map((r) => [r.patientId, r.patientNumber]))
    return rows.map((r) => ({ ...r, patientNumber: numberOf.get(r.patient.id) ?? null }))
  }

  // ── Queues ──────────────────────────────────────────────

  /** The doctor's own appointments for the day (default: today). */
  async doctorQueue(hospitalId: string, doctorId: string, from?: string, to?: string) {
    const { start, end } = this.dayRange(from, to)
    const rows = await this.prisma.appointment.findMany({
      where: {
        hospitalId,
        doctorId,
        deletedAt: null,
        status: { not: AppointmentStatus.CANCELLED },
        scheduledAt: { gte: start, lt: end },
      },
      select: {
        id: true,
        type: true,
        status: true,
        scheduledAt: true,
        duration: true,
        reason: true,
        patient: { select: { id: true, firstName: true, lastName: true, avatar: true, dateOfBirth: true, gender: true } },
      },
      orderBy: { scheduledAt: 'asc' },
    })
    return this.withVitalsFlag(await this.withPatientNumbers(hospitalId, rows))
  }

  /** Patients who have arrived and are waiting or being seen — for nurses taking vitals. */
  async nurseQueue(hospitalId: string, from?: string, to?: string) {
    const { start, end } = this.dayRange(from, to)
    const rows = await this.prisma.appointment.findMany({
      where: {
        hospitalId,
        deletedAt: null,
        status: { in: [AppointmentStatus.CHECKED_IN, AppointmentStatus.IN_PROGRESS] },
        scheduledAt: { gte: start, lt: end },
      },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        reason: true,
        patient: { select: { id: true, firstName: true, lastName: true, avatar: true, dateOfBirth: true, gender: true } },
        doctor: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { scheduledAt: 'asc' },
    })
    return this.withVitalsFlag(await this.withPatientNumbers(hospitalId, rows))
  }

  // ── A single visit ──────────────────────────────────────

  async getVisit(hospitalId: string, doctorId: string, appointmentId: string) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, hospitalId, doctorId, deletedAt: null },
      select: {
        id: true,
        type: true,
        status: true,
        scheduledAt: true,
        duration: true,
        reason: true,
        completedAt: true,
        patient: { select: { id: true, firstName: true, lastName: true, avatar: true, dateOfBirth: true, gender: true } },
        records: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            type: true,
            title: true,
            createdAt: true,
            createdBy: { select: { firstName: true, lastName: true, role: true } },
            consultation: true,
            vitals: true,
            prescription: { include: { medications: true } },
          },
        },
        labOrders: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true, testName: true, priority: true, status: true, clinicalNotes: true, cancelReason: true, createdAt: true,
            resultRecord: { select: { labResult: { select: { overallStatus: true, impression: true, results: true } } } },
          },
        },
      },
    })
    if (!appointment) throw new NotFoundException('Appointment not found')
    const [withNumber] = await this.withPatientNumbers(hospitalId, [appointment])
    return withNumber
  }

  async startVisit(hospitalId: string, doctorId: string, appointmentId: string) {
    const appointment = await this.ownAppointment(hospitalId, appointmentId, doctorId)

    // Telemedicine patients don't pass through the front desk, so a confirmed
    // appointment may be started directly.
    const allowed: AppointmentStatus[] = [AppointmentStatus.CHECKED_IN]
    if (appointment.type === AppointmentType.TELEMEDICINE) allowed.push(AppointmentStatus.CONFIRMED)
    this.requireStatus(appointment.status, allowed, 'start the visit')

    // A conditional update so two clicks can't both succeed.
    const result = await this.prisma.appointment.updateMany({
      where: { id: appointment.id, status: { in: allowed } },
      data: { status: AppointmentStatus.IN_PROGRESS },
    })
    if (result.count === 0) throw new ConflictException('This visit was already started')

    await this.audit({
      hospitalId, userId: doctorId, action: 'UPDATE', entity: 'Appointment', entityId: appointment.id,
      after: { status: AppointmentStatus.IN_PROGRESS },
    })
    return { id: appointment.id, status: AppointmentStatus.IN_PROGRESS }
  }

  async completeVisit(hospitalId: string, doctorId: string, appointmentId: string) {
    const appointment = await this.ownAppointment(hospitalId, appointmentId, doctorId)
    this.requireStatus(appointment.status, [AppointmentStatus.IN_PROGRESS], 'complete the visit')

    const consultations = await this.prisma.medicalRecord.count({
      where: { appointmentId: appointment.id, type: RecordType.CONSULTATION, deletedAt: null },
    })
    if (consultations === 0) {
      throw new BadRequestException('Record the consultation notes before completing the visit')
    }

    const result = await this.prisma.appointment.updateMany({
      where: { id: appointment.id, status: AppointmentStatus.IN_PROGRESS },
      data: { status: AppointmentStatus.COMPLETED, completedAt: new Date() },
    })
    if (result.count === 0) throw new ConflictException('This visit was already completed')

    await this.audit({
      hospitalId, userId: doctorId, action: 'UPDATE', entity: 'Appointment', entityId: appointment.id,
      after: { status: AppointmentStatus.COMPLETED },
    })
    return { id: appointment.id, status: AppointmentStatus.COMPLETED }
  }

  // ── Patient lookup and chart ────────────────────────────

  /**
   * Doctors can find any patient registered at their own hospital, by name,
   * phone, email or patient number. Every chart they open is audited.
   */
  async searchPatients(hospitalId: string, query: string) {
    const q = (query ?? '').trim()
    if (q.length < 2) return []

    // Every word has to match somewhere, so "ada obi" finds Ada Obi.
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 4)
    const rows = await this.prisma.hospitalPatient.findMany({
      where: {
        hospitalId,
        AND: tokens.map((t): Prisma.HospitalPatientWhereInput => ({
          OR: [
            { patientNumber: { contains: t, mode: 'insensitive' } },
            { patient: { firstName: { contains: t, mode: 'insensitive' } } },
            { patient: { lastName: { contains: t, mode: 'insensitive' } } },
            { patient: { phone: { contains: t } } },
            { patient: { email: { contains: t, mode: 'insensitive' } } },
          ],
        })),
      },
      select: {
        patientNumber: true,
        status: true,
        patient: {
          select: { id: true, firstName: true, lastName: true, avatar: true, dateOfBirth: true, gender: true, phone: true },
        },
      },
      orderBy: { registeredAt: 'desc' },
      take: 20,
    })
    return rows
  }

  /** Records that this doctor opened a patient's chart (once per 10 minutes per patient). */
  private async auditChartView(hospitalId: string, doctorId: string, patientId: string) {
    const recent = await this.prisma.auditLog.findFirst({
      where: {
        hospitalId, userId: doctorId, entity: 'PatientChart', entityId: patientId,
        createdAt: { gt: new Date(Date.now() - DUPLICATE_VIEW_WINDOW_MS) },
      },
      select: { id: true },
    })
    if (!recent) {
      await this.audit({
        hospitalId, userId: doctorId, action: 'VIEW', entity: 'PatientChart', entityId: patientId,
      })
    }
  }

  private async requireRegistered(hospitalId: string, patientId: string) {
    const registration = await this.prisma.hospitalPatient.findFirst({
      where: { hospitalId, patientId },
      select: { patientNumber: true, status: true },
    })
    if (!registration) throw new NotFoundException('Patient not found')
    return registration
  }

  /** A patient's full record history at this hospital, newest first, 20 per page. */
  async getPatientRecords(hospitalId: string, doctorId: string, patientId: string, page = 1) {
    await this.requireRegistered(hospitalId, patientId)
    await this.auditChartView(hospitalId, doctorId, patientId)

    const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
    const pageSize = 20
    const [total, records] = await Promise.all([
      this.prisma.medicalRecord.count({ where: { hospitalId, patientId, deletedAt: null } }),
      this.prisma.medicalRecord.findMany({
        where: { hospitalId, patientId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, type: true, title: true, createdAt: true, appointmentId: true,
          createdBy: { select: { firstName: true, lastName: true, role: true } },
          consultation: { select: { diagnosis: true, symptoms: true, findings: true, notes: true, followUpDate: true } },
          vitals: true,
          labResult: { select: { testName: true, overallStatus: true, impression: true, results: true } },
          prescription: { select: { status: true, medications: { select: { name: true, dosage: true, frequency: true, duration: true } } } },
        },
      }),
    ])
    return { page: safePage, pageSize, total, records }
  }

  async getChart(hospitalId: string, doctorId: string, patientId: string) {
    const registration = await this.requireRegistered(hospitalId, patientId)
    await this.auditChartView(hospitalId, doctorId, patientId)

    const [patient, records, activePrescriptions] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: patientId },
        select: {
          id: true, firstName: true, lastName: true, avatar: true, dateOfBirth: true, gender: true, phone: true,
          patientProfile: {
            select: {
              bloodGroup: true, allergies: true, chronicConditions: true, weight: true, height: true,
              emergencyName: true, emergencyPhone: true, emergencyRelation: true,
            },
          },
        },
      }),
      this.prisma.medicalRecord.findMany({
        where: { hospitalId, patientId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true, type: true, title: true, summary: true, createdAt: true,
          createdBy: { select: { firstName: true, lastName: true } },
          consultation: { select: { diagnosis: true, findings: true, followUpDate: true } },
          vitals: true,
          prescription: { select: { status: true, medications: { select: { name: true, dosage: true, frequency: true, duration: true } } } },
        },
      }),
      this.prisma.prescription.findMany({
        where: { status: 'ACTIVE', record: { hospitalId, patientId, deletedAt: null } },
        select: {
          id: true, expiryDate: true, createdAt: true,
          medications: { select: { name: true, dosage: true, frequency: true, duration: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ])
    if (!patient) throw new NotFoundException('Patient not found')

    return {
      patientNumber: registration.patientNumber,
      registrationStatus: registration.status,
      patient,
      recentRecords: records,
      activePrescriptions,
    }
  }

  // ── Recording clinical data ─────────────────────────────

  /** Doctors (own patients) and nurses (any arrived patient in the hospital) can record vitals. */
  async recordVitals(
    hospitalId: string, actor: { id: string; role: Role }, appointmentId: string, dto: VitalsDto,
  ) {
    const hasValue = [dto.bpSystolic, dto.bpDiastolic, dto.pulse, dto.temperature, dto.spo2, dto.weight, dto.height]
      .some((v) => v !== undefined && v !== null)
    if (!hasValue) throw new BadRequestException('Enter at least one measurement')
    if ((dto.bpSystolic === undefined) !== (dto.bpDiastolic === undefined)) {
      throw new BadRequestException('Enter both blood pressure numbers, or neither')
    }
    if (dto.bpSystolic !== undefined && dto.bpDiastolic !== undefined && dto.bpDiastolic >= dto.bpSystolic) {
      throw new BadRequestException('The lower blood pressure number must be less than the upper one')
    }

    const appointment = actor.role === Role.DOCTOR
      ? await this.ownAppointment(hospitalId, appointmentId, actor.id)
      : await this.prisma.appointment.findFirst({
          where: { id: appointmentId, hospitalId, deletedAt: null },
          select: { id: true, status: true, type: true, patientId: true, doctorId: true },
        })
    if (!appointment) throw new NotFoundException('Appointment not found')
    this.requireStatus(
      appointment.status,
      [AppointmentStatus.CHECKED_IN, AppointmentStatus.IN_PROGRESS],
      'record vitals',
    )

    const bmi = dto.weight && dto.height
      ? Math.round((dto.weight / Math.pow(dto.height / 100, 2)) * 10) / 10
      : undefined

    const record = await this.prisma.medicalRecord.create({
      data: {
        hospitalId,
        patientId: appointment.patientId,
        appointmentId: appointment.id,
        createdById: actor.id,
        type: RecordType.VITALS,
        title: 'Vital signs',
        vitals: {
          create: {
            bpSystolic: dto.bpSystolic,
            bpDiastolic: dto.bpDiastolic,
            pulse: dto.pulse,
            temperature: dto.temperature,
            spo2: dto.spo2,
            weight: dto.weight,
            height: dto.height,
            bmi,
            notes: dto.notes?.trim() || undefined,
          },
        },
      },
      select: { id: true, vitals: true },
    })

    await this.audit({
      hospitalId, userId: actor.id, action: 'CREATE', entity: 'MedicalRecord', entityId: record.id,
      after: { type: RecordType.VITALS, appointmentId: appointment.id },
    })
    return record
  }

  async recordConsultation(hospitalId: string, doctorId: string, appointmentId: string, dto: ConsultationDto) {
    const appointment = await this.ownAppointment(hospitalId, appointmentId, doctorId)
    this.requireStatus(appointment.status, [AppointmentStatus.IN_PROGRESS], 'record the consultation')

    const existing = await this.prisma.medicalRecord.count({
      where: { appointmentId: appointment.id, type: RecordType.CONSULTATION, deletedAt: null },
    })
    if (existing > 0) {
      throw new ConflictException('The consultation for this visit is already recorded. Complete the visit, then add an addendum if something needs correcting.')
    }

    let followUpDate: Date | undefined
    if (dto.followUpDate) {
      followUpDate = new Date(dto.followUpDate)
      if (followUpDate.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
        throw new BadRequestException('The follow-up date cannot be in the past')
      }
    }

    const diagnosis = dto.diagnosis.trim()
    const record = await this.prisma.medicalRecord.create({
      data: {
        hospitalId,
        patientId: appointment.patientId,
        appointmentId: appointment.id,
        createdById: doctorId,
        type: RecordType.CONSULTATION,
        title: `Consultation: ${diagnosis.slice(0, 80)}`,
        summary: diagnosis,
        consultation: {
          create: {
            diagnosis,
            symptoms: (dto.symptoms ?? []).map((s) => s.trim()).filter(Boolean),
            findings: dto.findings.trim(),
            notes: dto.notes?.trim() || undefined,
            followUpDate,
          },
        },
      },
      select: { id: true },
    })

    await this.audit({
      hospitalId, userId: doctorId, action: 'CREATE', entity: 'MedicalRecord', entityId: record.id,
      after: { type: RecordType.CONSULTATION, appointmentId: appointment.id },
    })
    return record
  }

  /**
   * Finished consultations are never edited. A correction is a new, clearly
   * labelled record added to the same visit.
   */
  async addAddendum(hospitalId: string, doctorId: string, appointmentId: string, dto: AddendumDto) {
    const appointment = await this.ownAppointment(hospitalId, appointmentId, doctorId)
    this.requireStatus(
      appointment.status,
      [AppointmentStatus.IN_PROGRESS, AppointmentStatus.COMPLETED],
      'add an addendum',
    )
    const note = dto.note.trim()
    const record = await this.prisma.medicalRecord.create({
      data: {
        hospitalId,
        patientId: appointment.patientId,
        appointmentId: appointment.id,
        createdById: doctorId,
        type: RecordType.CONSULTATION,
        title: 'Addendum',
        summary: note.slice(0, 200),
        consultation: { create: { diagnosis: 'Addendum', symptoms: [], findings: note } },
      },
      select: { id: true },
    })
    await this.audit({
      hospitalId, userId: doctorId, action: 'CREATE', entity: 'MedicalRecord', entityId: record.id,
      after: { type: RecordType.CONSULTATION, addendum: true, appointmentId: appointment.id },
    })
    return record
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

  async prescribe(hospitalId: string, doctorId: string, appointmentId: string, dto: PrescriptionDto) {
    const appointment = await this.ownAppointment(hospitalId, appointmentId, doctorId)
    this.requireStatus(appointment.status, [AppointmentStatus.IN_PROGRESS], 'prescribe')

    let expiryDate: Date | undefined
    if (dto.expiryDate) {
      expiryDate = new Date(dto.expiryDate)
      if (expiryDate.getTime() < Date.now()) throw new BadRequestException('The expiry date cannot be in the past')
    }

    const profile = await this.prisma.patientProfile.findUnique({
      where: { userId: appointment.patientId },
      select: { allergies: true },
    })
    const matches = this.allergyMatches(profile?.allergies ?? [], dto.medications.map((m) => m.name))
    if (matches.length > 0 && !dto.confirmAllergyOverride) {
      throw new ConflictException({
        statusCode: 409,
        code: 'ALLERGY_WARNING',
        message: 'This patient has a recorded allergy that matches a prescribed medication.',
        matches,
      })
    }

    const names = dto.medications.map((m) => m.name.trim())
    const record = await this.prisma.medicalRecord.create({
      data: {
        hospitalId,
        patientId: appointment.patientId,
        appointmentId: appointment.id,
        createdById: doctorId,
        type: RecordType.PRESCRIPTION,
        title: `Prescription: ${names.join(', ').slice(0, 100)}`,
        prescription: {
          create: {
            expiryDate,
            refillsAllowed: dto.refillsAllowed ?? 0,
            notes: dto.notes?.trim() || undefined,
            medications: {
              create: dto.medications.map((m) => ({
                name: m.name.trim(),
                dosage: m.dosage.trim(),
                frequency: m.frequency.trim(),
                duration: m.duration.trim(),
                instructions: m.instructions?.trim() || undefined,
              })),
            },
          },
        },
      },
      select: { id: true, prescription: { include: { medications: true } } },
    })

    await this.audit({
      hospitalId, userId: doctorId, action: 'CREATE', entity: 'MedicalRecord', entityId: record.id,
      after: {
        type: RecordType.PRESCRIPTION,
        appointmentId: appointment.id,
        medications: names,
        ...(matches.length > 0 && { allergyOverride: true, allergyMatches: matches }),
      },
    })
    return record
  }

  async orderLabTests(hospitalId: string, doctorId: string, appointmentId: string, dto: LabOrdersDto) {
    const appointment = await this.ownAppointment(hospitalId, appointmentId, doctorId)
    this.requireStatus(appointment.status, [AppointmentStatus.IN_PROGRESS], 'request lab tests')

    const orders = await this.prisma.$transaction(
      dto.tests.map((t) =>
        this.prisma.labOrder.create({
          data: {
            hospitalId,
            patientId: appointment.patientId,
            orderedById: doctorId,
            appointmentId: appointment.id,
            testName: t.testName.trim(),
            priority: t.priority,
            clinicalNotes: t.clinicalNotes?.trim() || undefined,
          },
          select: { id: true, testName: true, priority: true, status: true },
        }),
      ),
    )

    await this.audit({
      hospitalId, userId: doctorId, action: 'CREATE', entity: 'LabOrder', entityId: orders[0].id,
      after: { appointmentId: appointment.id, tests: orders.map((o) => o.testName) },
    })
    return orders
  }
}