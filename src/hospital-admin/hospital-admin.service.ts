import { auditMeta } from '../common/request-context'
import { Injectable, NotFoundException, ConflictException, ForbiddenException, Logger, BadRequestException, HttpException, HttpStatus } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { EmailService } from 'src/email/email.service'
import { Role, Gender, BloodGroup, HospitalPatientStatus, AppointmentStatus, AppointmentType, BillStatus } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { StorageService } from 'src/storage/storage.service'


// The only roles a Hospital Admin is allowed to create — deliberately
// excludes ADMIN and SUPER_ADMIN. A hospital admin should never be able
// to create another admin for their own hospital (that stays a Super
// Admin action) or, obviously, a platform-level Super Admin account.
const INVITABLE_STAFF_ROLES: Role[] = [
  Role.DOCTOR, Role.NURSE, Role.PHARMACIST, Role.LAB_TECHNICIAN, Role.DIETICIAN,
  Role.RECEPTIONIST, Role.ACCOUNTANT,
]

// Statuses that still occupy a doctor's time slot.
const ACTIVE_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.PENDING,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.CHECKED_IN,
  AppointmentStatus.IN_PROGRESS,
]
 
// Per-account limit on patient lookups: 10 per minute, 100 per hour.
const LOOKUP_WINDOWS = [
  { ms: 60_000, max: 10 },
  { ms: 3_600_000, max: 100 },
]
const lookupHits = new Map<string, number[]>()

function enforceLookupLimit(actorId: string) {
  const now = Date.now()
  const longest = LOOKUP_WINDOWS[LOOKUP_WINDOWS.length - 1].ms
  const hits = (lookupHits.get(actorId) ?? []).filter((t) => now - t < longest)
  for (const w of LOOKUP_WINDOWS) {
    if (hits.filter((t) => now - t < w.ms).length >= w.max) {
      lookupHits.set(actorId, hits)
      throw new HttpException(
        'Too many patient lookups. Please wait a moment and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
  }
  hits.push(now)
  lookupHits.set(actorId, hits)
  if (lookupHits.size > 5000) {
    for (const [k, v] of lookupHits) if (!v.some((t) => now - t < longest)) lookupHits.delete(k)
  }
}

// Specialisation / licence number as typed by an admin: trimmed and length-limited.
// undefined = not provided (leave as is), null = cleared.
function cleanProfileText(value: unknown, max: number, label: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new BadRequestException(`${label} must be text`)
  const v = value.trim()
  if (v.length > max) throw new BadRequestException(`${label} must be ${max} characters or fewer`)
  return v === '' ? null : v
}

@Injectable()
export class HospitalAdminService {
  private readonly logger = new Logger(HospitalAdminService.name)
 
  // Makes before/after values comparable and JSON-safe: Dates become ISO
  // strings, Prisma Decimals become numbers, undefined becomes null.
  private normaliseAuditValue(value: unknown): unknown {
    if (value === undefined) return null
    if (value instanceof Date) return value.toISOString()
    if (value !== null && typeof value === 'object' && 'toNumber' in (value as any)) {
      return (value as any).toNumber()
    }
    return value
  }
 
  // Compares two flat snapshots over the keys present in `after` and
  // returns ONLY the fields that actually changed (so the audit viewer
  // shows "phone: 0801… → 0802…" instead of the whole form), or null if
  // nothing changed
  private diffForAudit(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
    const changedBefore: Record<string, unknown> = {}
    const changedAfter: Record<string, unknown> = {}
 
    for (const key of Object.keys(after)) {
      const b = this.normaliseAuditValue(before[key])
      const a = this.normaliseAuditValue(after[key])
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        changedBefore[key] = b
        changedAfter[key] = a
      }
    }
 
    return Object.keys(changedAfter).length > 0
      ? { before: changedBefore, after: changedAfter }
      : null
  }

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private storageService: StorageService,
  ) {}
 
  // ── Dashboard stats ──────────────────────────────────────
  async getStats(hospitalId: string) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
 
    const [departmentCount, staffCount, patientCount, appointmentCount] = await Promise.all([
      this.prisma.department.count({ where: { hospitalId, deletedAt: null } }),
      this.prisma.user.count({ where: { hospitalId, role: { in: INVITABLE_STAFF_ROLES } } }),
      this.prisma.hospitalPatient.count({ where: { hospitalId } }),
      this.prisma.appointment.count({
        where: { hospitalId, scheduledAt: { gte: today, lt: tomorrow }, deletedAt: null },
      }),
    ])
 
    return { departmentCount, staffCount, patientCount, appointmentCount }
  }
 
  // ── Departments ──────────────────────────────────────────
  async findAllDepartments(hospitalId: string) {
    return this.prisma.department.findMany({
      where: { hospitalId, deletedAt: null },
      select: {
        id: true,
        name: true,
        createdAt: true,
        _count: { select: { staff: true } },
      },
      orderBy: { name: 'asc' },
    })
  }
 
  // Department detail — returns the department plus its full staff list,
  // so the frontend can show "who's in Cardiology" without a separate
  // client-side filter of the whole hospital's staff.
  async getDepartmentDetail(hospitalId: string, departmentId: string) {
    const department = await this.prisma.department.findFirst({
      where: { id: departmentId, hospitalId, deletedAt: null },
      select: { id: true, name: true, createdAt: true },
    })
    if (!department) throw new NotFoundException('Department not found')
 
    const staff = await this.prisma.user.findMany({
      where: { departmentId, hospitalId, role: { in: INVITABLE_STAFF_ROLES } },
      select: {
        id: true, firstName: true, lastName: true, email: true, role: true, active: true,
      },
      orderBy: { firstName: 'asc' },
    })
 
    return { ...department, staff }
  }

  async createDepartment(hospitalId: string, name: string, actorId: string) {
    const existing = await this.prisma.department.findFirst({
      where: { hospitalId, name: { equals: name, mode: 'insensitive' }, deletedAt: null },
    })
    if (existing) {
      throw new ConflictException('A department with this name already exists')
    }
 
    const department = await this.prisma.department.create({
      data: { hospitalId, name },
    })
 
    await this.logAudit({
      hospitalId,
      userId: actorId,
      action: 'CREATE',
      entity: 'Department',
      entityId: department.id,
      after: { name: department.name },
    })
 
    return department
  }
 
  async updateDepartment(hospitalId: string, departmentId: string, name: string, actorId: string) {
    const department = await this.prisma.department.findFirst({
      where: { id: departmentId, hospitalId, deletedAt: null },
    })
    if (!department) throw new NotFoundException('Department not found')
 
    const updated = await this.prisma.department.update({
      where: { id: departmentId },
      data: { name },
    })
 if (department.name !== updated.name) {
    await this.logAudit({
      hospitalId,
      userId: actorId,
      action: 'UPDATE',
      entity: 'Department',
      entityId: department.id,
      before: { name: department.name },
      after: { name: updated.name },
    })
  }
 
    return updated
  }
 

  async deleteDepartment(hospitalId: string, departmentId: string, actorId: string) {
    const department = await this.prisma.department.findFirst({
      where: { id: departmentId, hospitalId, deletedAt: null },
    })
    if (!department) throw new NotFoundException('Department not found')
 
    await this.prisma.department.update({
      where: { id: departmentId },
      data: { deletedAt: new Date() },
    })
 
    await this.logAudit({
      hospitalId,
      userId: actorId,
      action: 'DELETE',
      entity: 'Department',
      entityId: department.id,
      before: { name: department.name },
    })
 
    return { message: 'Department removed' }
  }
 
  // ── Staff ──────────────────────────────────────────────────
  async findAllStaff(hospitalId: string) {
    return this.prisma.user.findMany({
      where: { hospitalId, role: { in: INVITABLE_STAFF_ROLES } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        active: true,
        avatar: true,
        department: { select: { id: true, name: true } },
        createdAt: true,
        staffProfile: { select: { specialization: true, licenseNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
  }
 
  async getStaffDetail(hospitalId: string, staffId: string) {
    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, hospitalId, role: { in: INVITABLE_STAFF_ROLES } },
      select: {
        id: true, firstName: true, lastName: true, email: true, role: true,
        active: true, avatar: true, department: { select: { id: true, name: true } }, createdAt: true,
        staffProfile: { select: { specialization: true, licenseNumber: true } },
      },
    })
    if (!staff) throw new NotFoundException('Staff member not found')
    return staff
  }
 
  async inviteStaff(
    hospitalId: string,
    hospitalName: string,
    dto: {
      firstName: string
      lastName: string
      email: string
      role: Role
      departmentId?: string
      specialization?: string | null
      licenseNumber?: string | null
    },
    actorId: string,
  ) {
    if (!INVITABLE_STAFF_ROLES.includes(dto.role)) {
      throw new ForbiddenException('You are not permitted to create a staff account with this role')
    }
 
    const specialization = cleanProfileText(dto.specialization, 100, 'Specialisation')
    const licenseNumber = cleanProfileText(dto.licenseNumber, 50, 'Licence number')

    const existing = await this.prisma.user.findUnique({ where: { email: String(dto.email).trim().toLowerCase() } })
    if (existing) {
      throw new ConflictException('A user with this email already exists')
    }
 
    if (dto.departmentId) {
      const department = await this.prisma.department.findFirst({
        where: { id: dto.departmentId, hospitalId, deletedAt: null },
      })
      if (!department) throw new NotFoundException('Department not found')
    }
 
    // Check the hospital's invite-mode toggle
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { emailInvitesEnabled: true },
    })
 
    const tempPassword = crypto.randomBytes(6).toString('hex')
    const passwordHash = await bcrypt.hash(tempPassword, 12)
 
    const staff = await this.prisma.user.create({
      data: {
        email: String(dto.email).trim().toLowerCase(),
        firstName: dto.firstName,
        lastName: dto.lastName,
        passwordHash,
        role: dto.role,
        hospitalId,
        departmentId: dto.departmentId,
        emailVerified: false,
        hasPassword: true,
        staffProfile: specialization || licenseNumber
          ? { create: { specialization, licenseNumber } }
          : undefined,
      },
      select: {
        id: true, email: true, firstName: true, lastName: true, role: true,
      },
    })
 
    this.logger.log(`Staff invited: ${staff.email} (${staff.role}) at hospital ${hospitalId}`)
 
    // Only email if the hospital has it enabled (default true)
    let emailSent = false
    if (hospital?.emailInvitesEnabled !== false) {
      emailSent = await this.emailService.sendStaffInviteEmail(
        staff.email,
        `${staff.firstName} ${staff.lastName}`,
        hospitalName,
        staff.role,
        tempPassword,
      )
    }
 
    // The temporary password is deliberately NOT logged.
    await this.logAudit({
      hospitalId,
      userId: actorId,
      action: 'CREATE',
      entity: 'Staff',
      entityId: staff.id,
      after: {
        name: `${staff.firstName} ${staff.lastName}`,
        email: staff.email,
        role: staff.role,
        departmentId: dto.departmentId ?? null,
        inviteEmailSent: emailSent,
        specialization: specialization ?? null,
        licenseNumber: licenseNumber ?? null,
      },
    })
 
    return { staff, temporaryPassword: tempPassword, emailSent }
  }
 
  // Edit an existing staff member's name/department (not email or role —
  // changing those is significant enough to warrant a more deliberate
  // flow later, e.g. re-verification, rather than a quick inline edit)
  async updateStaff(
    hospitalId: string,
    staffId: string,
    dto: {
      firstName?: string
      lastName?: string
      departmentId?: string | null
      specialization?: string | null
      licenseNumber?: string | null
    },
    actorId: string,
  ) {
    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, hospitalId, role: { in: INVITABLE_STAFF_ROLES } },
      include: { staffProfile: { select: { specialization: true, licenseNumber: true } } },
    })
    if (!staff) throw new NotFoundException('Staff member not found')

    const specialization = cleanProfileText(dto.specialization, 100, 'Specialisation')
    const licenseNumber = cleanProfileText(dto.licenseNumber, 50, 'Licence number')
 
    if (dto.departmentId) {
      const department = await this.prisma.department.findFirst({
        where: { id: dto.departmentId, hospitalId, deletedAt: null },
      })
      if (!department) throw new NotFoundException('Department not found')
    }
 
    if (specialization !== undefined || licenseNumber !== undefined) {
      await this.prisma.staffProfile.upsert({
        where: { userId: staffId },
        create: { userId: staffId, specialization: specialization ?? null, licenseNumber: licenseNumber ?? null },
        update: {
          ...(specialization !== undefined ? { specialization } : {}),
          ...(licenseNumber !== undefined ? { licenseNumber } : {}),
        },
      })
    }

    const updated = await this.prisma.user.update({
      where: { id: staffId },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        departmentId: dto.departmentId === null ? null : dto.departmentId,
      },
      select: {
        id: true, firstName: true, lastName: true, email: true, role: true,
        active: true, department: { select: { id: true, name: true } },
        staffProfile: { select: { specialization: true, licenseNumber: true } },
      },
    })
 
    // ── Audit: only the fields that actually changed ──
    const beforeSnapshot: Record<string, unknown> = {
      firstName: staff.firstName,
      lastName: staff.lastName,
      departmentId: staff.departmentId,
      specialization: staff.staffProfile?.specialization ?? null,
      licenseNumber: staff.staffProfile?.licenseNumber ?? null,
    }
    const afterSnapshot: Record<string, unknown> = {}
    if (dto.firstName !== undefined) afterSnapshot.firstName = dto.firstName
    if (dto.lastName !== undefined) afterSnapshot.lastName = dto.lastName
    if (dto.departmentId !== undefined) afterSnapshot.departmentId = dto.departmentId
    if (specialization !== undefined) afterSnapshot.specialization = specialization
    if (licenseNumber !== undefined) afterSnapshot.licenseNumber = licenseNumber
 
    const diff = this.diffForAudit(beforeSnapshot, afterSnapshot)
    if (diff) {
      // Department ids are opaque in the viewer, so attach readable names.
      if ('departmentId' in diff.after) {
        const ids = [diff.before.departmentId, diff.after.departmentId].filter(
          (v): v is string => typeof v === 'string',
        )
        const departments = ids.length
          ? await this.prisma.department.findMany({
              where: { id: { in: ids } },
              select: { id: true, name: true },
            })
          : []
        const nameOf = (id: unknown) =>
          typeof id === 'string' ? departments.find((d) => d.id === id)?.name ?? null : null
        diff.before.departmentName = nameOf(diff.before.departmentId)
        diff.after.departmentName = nameOf(diff.after.departmentId)
      }
 
      await this.logAudit({
        hospitalId,
        userId: actorId,
        action: 'UPDATE',
        entity: 'Staff',
        entityId: staffId,
        before: { name: `${staff.firstName} ${staff.lastName}`, ...diff.before },
        after: diff.after,
      })
    }
 
    return updated
  }
 
  async setStaffActive(hospitalId: string, staffId: string, active: boolean, actorId: string) {
    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, hospitalId, role: { in: INVITABLE_STAFF_ROLES } },
    })
    if (!staff) throw new NotFoundException('Staff member not found')
 
    const updated = await this.prisma.user.update({
      where: { id: staffId },
      data: { active },
      select: {
        id: true, firstName: true, lastName: true, email: true, role: true,
        active: true, department: { select: { id: true, name: true } },
      },
    })
 
    if (staff.active !== active) {
      const name = `${staff.firstName} ${staff.lastName}`
      await this.logAudit({
        hospitalId,
        userId: actorId,
        action: 'UPDATE',
        entity: 'Staff',
        entityId: staffId,
        before: { name, active: staff.active },
        after: { name, active },
      })
    }
 
    return updated
  }
 
  // Admin-triggered password reset — generates a fresh temp password and
  // emails it to the staff member, same pattern as the initial invite.
   async resetStaffPassword(
    hospitalId: string,
    staffId: string,
    hospitalName: string,
    emailInvitesEnabled: boolean,
    actorId: string,
  ) {
    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, hospitalId, role: { in: INVITABLE_STAFF_ROLES } },
    })
    if (!staff) throw new NotFoundException('Staff member not found')
 
    const tempPassword = crypto.randomBytes(6).toString('hex')
    const passwordHash = await bcrypt.hash(tempPassword, 12)
 
    await this.prisma.user.update({
      where: { id: staffId },
      data: { passwordHash },
    })
 
    // Revoke existing sessions so the old password can't keep being used
    // elsewhere once it's been reset
    await this.prisma.refreshToken.updateMany({
      where: { userId: staffId },
      data: { revoked: true },
    })
 
    let emailSent = false
    if (emailInvitesEnabled) {
      emailSent = await this.emailService.sendStaffInviteEmail(
        staff.email,
        `${staff.firstName} ${staff.lastName}`,
        hospitalName,
        staff.role,
        tempPassword,
      )
    }
 
    // Records that a reset happened, never the password itself.
    await this.logAudit({
      hospitalId,
      userId: actorId,
      action: 'UPDATE',
      entity: 'Staff',
      entityId: staffId,
      after: {
        name: `${staff.firstName} ${staff.lastName}`,
        passwordReset: true,
        sessionsRevoked: true,
        resetEmailSent: emailSent,
      },
    })
 
    return { temporaryPassword: tempPassword, emailSent }
  }
 
  // ── Hospital's own profile ───────────────────────────────
  async getHospitalProfile(hospitalId: string) {
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: {
        id: true, name: true, type: true, address: true, city: true,
        state: true, country: true, phone: true, email: true, website: true,
        logo: true, verified: true, plan: true, planStatus: true, planExpiry: true,
        emailInvitesEnabled: true,
      },
    })
 
    if (!hospital) throw new NotFoundException('Hospital not found')
    return hospital
  }
 
  async updateHospitalProfile(
    hospitalId: string,
    dto: {
      name?: string
      address?: string
      city?: string
      state?: string
      phone?: string
      website?: string
      logo?: string
      emailInvitesEnabled?: boolean
    },
    actorId: string,
  ) {
    const EDITABLE = [
      'name', 'address', 'city', 'state', 'phone', 'website', 'logo', 'emailInvitesEnabled',
    ] as const
 
    const data: Record<string, unknown> = {}
    for (const key of EDITABLE) {
      if (dto[key] !== undefined) data[key] = dto[key]
    }
 
    const current = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: {
        name: true, address: true, city: true, state: true,
        phone: true, website: true, logo: true, emailInvitesEnabled: true,
      },
    })
    if (!current) throw new NotFoundException('Hospital not found')
 
    const updated = await this.prisma.hospital.update({
      where: { id: hospitalId },
      data,
      select: {
        id: true, name: true, type: true, address: true, city: true,
        state: true, country: true, phone: true, email: true, website: true,
        logo: true, verified: true, plan: true, planStatus: true,
        emailInvitesEnabled: true,
      },
    })
 
    const diff = this.diffForAudit(current as Record<string, unknown>, data)
    if (diff) {
      await this.logAudit({
        hospitalId,
        userId: actorId,
        action: 'UPDATE',
        entity: 'Hospital',
        entityId: hospitalId,
        before: diff.before,
        after: diff.after,
      })
    }
 
    return updated
  }


  async updateHospitalLogo(hospitalId: string, file: Express.Multer.File, actorId: string) {
  // Capture the current logo first so the log can show old → new
  const current = await this.prisma.hospital.findUnique({
    where: { id: hospitalId },
    select: { logo: true },
  })

  const url = await this.storageService.uploadImage(file, 'logos')
  const updated = await this.prisma.hospital.update({
    where: { id: hospitalId },
    data: { logo: url },
    select: { id: true, logo: true },
  })

  await this.logAudit({
    hospitalId,
    userId: actorId,
    action: 'UPDATE',
    entity: 'Hospital',
    entityId: hospitalId,
    before: { logo: current?.logo ?? null },
    after: { logo: updated.logo },
  })

  return updated
}


  async updateStaffPhoto(hospitalId: string, staffId: string, file: Express.Multer.File, actorId: string) {
    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, hospitalId, role: { in: INVITABLE_STAFF_ROLES } },
    })
    if (!staff) throw new NotFoundException('Staff member not found')

    const url = await this.storageService.uploadImage(file, 'avatars')
    const updated = await this.prisma.user.update({
      where: { id: staffId },
      data: { avatar: url },
      select: { id: true, avatar: true },
    })

    await this.logAudit({
      hospitalId,
      userId: actorId,
      action: 'UPDATE',
      entity: 'Staff',
      entityId: staffId,
      before: { avatar: staff.avatar ?? null },
      after: { avatar: updated.avatar },
    })

    return updated
  }

    // ── Patients ────────────────────────────────────────────────
  async findAllPatients(hospitalId: string, search?: string) {
    return this.prisma.hospitalPatient.findMany({
      where: {
        hospitalId,
        ...(search
          ? {
              patient: {
                OR: [
                  { firstName: { contains: search, mode: 'insensitive' } },
                  { lastName: { contains: search, mode: 'insensitive' } },
                  { email: { contains: search, mode: 'insensitive' } },
                  { phone: { contains: search, mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      },
      select: {
        id: true,
        patientNumber: true,
        status: true,
        registeredAt: true,
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            avatar: true,
            dateOfBirth: true,
            gender: true,
          },
        },
      },
      orderBy: { registeredAt: 'desc' },
    })
  }

  async getPatientDetail(hospitalId: string, hospitalPatientId: string) {
    const record = await this.prisma.hospitalPatient.findFirst({
      where: { id: hospitalPatientId, hospitalId },
      select: {
        id: true,
        patientNumber: true,
        status: true,
        registeredAt: true,
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            avatar: true,
            dateOfBirth: true,
            gender: true,
            patientProfile: {
              select: {
                bloodGroup: true,
                allergies: true,
                chronicConditions: true,
                emergencyName: true,
                emergencyPhone: true,
                emergencyRelation: true,
                insuranceProvider: true,
                insuranceNumber: true,
                weight: true,
                height: true,
              },
            },
          },
        },
      },
    })
    if (!record) throw new NotFoundException('Patient not found')

    const [appointmentCount, recordCount] = await Promise.all([
      this.prisma.appointment.count({
        where: { hospitalId, patientId: record.patient.id, deletedAt: null },
      }),
      this.prisma.medicalRecord.count({
        where: { hospitalId, patientId: record.patient.id, deletedAt: null },
      }),
    ])

    return { ...record, appointmentCount, recordCount }
  }

   async updatePatientRecord(
    hospitalId: string,
    hospitalPatientId: string,
    dto: {
      firstName?: string
      lastName?: string
      phone?: string | null
      dateOfBirth?: string | null
      gender?: Gender | null
      status?: HospitalPatientStatus
      bloodGroup?: BloodGroup
      allergies?: string[]
      chronicConditions?: string[]
      weight?: number | null
      height?: number | null
      emergencyName?: string | null
      emergencyPhone?: string | null
      emergencyRelation?: string | null
      insuranceProvider?: string | null
      insuranceNumber?: string | null
    },
    actorId: string,
  ) {
    const record = await this.prisma.hospitalPatient.findFirst({
      where: { id: hospitalPatientId, hospitalId },
      select: { id: true, patientId: true, status: true },
    })
    if (!record) throw new NotFoundException('Patient not found')
 
    // ── Snapshot the current values BEFORE any write, for the audit diff ──
    const [userBefore, profileBefore] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: record.patientId },
        select: { firstName: true, lastName: true, phone: true, dateOfBirth: true, gender: true },
      }),
      this.prisma.patientProfile.findUnique({ where: { userId: record.patientId } }),
    ])
 
    const beforeSnapshot: Record<string, unknown> = {
      status: record.status,
      firstName: userBefore?.firstName,
      lastName: userBefore?.lastName,
      phone: userBefore?.phone,
      dateOfBirth: userBefore?.dateOfBirth ? userBefore.dateOfBirth.toISOString().slice(0, 10) : null,
      gender: userBefore?.gender,
      bloodGroup: profileBefore?.bloodGroup,
      allergies: profileBefore?.allergies,
      chronicConditions: profileBefore?.chronicConditions,
      weight: profileBefore?.weight,
      height: profileBefore?.height,
      emergencyName: profileBefore?.emergencyName,
      emergencyPhone: profileBefore?.emergencyPhone,
      emergencyRelation: profileBefore?.emergencyRelation,
      insuranceProvider: profileBefore?.insuranceProvider,
      insuranceNumber: profileBefore?.insuranceNumber,
    }
 
    // ── The actual update (unchanged logic) ──
    if (dto.status) {
      await this.prisma.hospitalPatient.update({
        where: { id: record.id },
        data: { status: dto.status },
      })
    }
 
    const userData: Record<string, any> = {}
    if (dto.firstName !== undefined) userData.firstName = dto.firstName
    if (dto.lastName !== undefined) userData.lastName = dto.lastName
    if (dto.phone !== undefined) userData.phone = dto.phone
    if (dto.dateOfBirth !== undefined) {
      userData.dateOfBirth = dto.dateOfBirth ? new Date(dto.dateOfBirth) : null
    }
    if (dto.gender !== undefined) userData.gender = dto.gender
    if (Object.keys(userData).length > 0) {
      await this.prisma.user.update({ where: { id: record.patientId }, data: userData })
    }
 
    const profileData: Record<string, any> = {}
    if (dto.bloodGroup !== undefined) profileData.bloodGroup = dto.bloodGroup
    if (dto.allergies !== undefined) profileData.allergies = dto.allergies
    if (dto.chronicConditions !== undefined) profileData.chronicConditions = dto.chronicConditions
    if (dto.weight !== undefined) profileData.weight = dto.weight
    if (dto.height !== undefined) profileData.height = dto.height
    if (dto.emergencyName !== undefined) profileData.emergencyName = dto.emergencyName
    if (dto.emergencyPhone !== undefined) profileData.emergencyPhone = dto.emergencyPhone
    if (dto.emergencyRelation !== undefined) profileData.emergencyRelation = dto.emergencyRelation
    if (dto.insuranceProvider !== undefined) profileData.insuranceProvider = dto.insuranceProvider
    if (dto.insuranceNumber !== undefined) profileData.insuranceNumber = dto.insuranceNumber
 
    if (Object.keys(profileData).length > 0) {
      await this.prisma.patientProfile.upsert({
        where: { userId: record.patientId },
        create: {
          userId: record.patientId,
          bloodGroup: dto.bloodGroup ?? BloodGroup.UNKNOWN,
          allergies: dto.allergies ?? [],
          chronicConditions: dto.chronicConditions ?? [],
          weight: dto.weight ?? undefined,
          height: dto.height ?? undefined,
          emergencyName: dto.emergencyName ?? undefined,
          emergencyPhone: dto.emergencyPhone ?? undefined,
          emergencyRelation: dto.emergencyRelation ?? undefined,
          insuranceProvider: dto.insuranceProvider ?? undefined,
          insuranceNumber: dto.insuranceNumber ?? undefined,
        },
        update: profileData,
      })
    }
 
    // ── Audit: log only the fields that genuinely changed ──
    const afterSnapshot: Record<string, unknown> = {}
    for (const key of Object.keys(beforeSnapshot)) {
      const value = (dto as Record<string, unknown>)[key]
      if (value === undefined) continue
      afterSnapshot[key] =
        key === 'dateOfBirth'
          ? value
            ? new Date(value as string).toISOString().slice(0, 10)
            : null
          : value
    }
 
    const diff = this.diffForAudit(beforeSnapshot, afterSnapshot)
    if (diff) {
      await this.logAudit({
        hospitalId,
        userId: actorId,
        action: 'UPDATE',
        entity: 'Patient',
        entityId: record.id,
        before: diff.before,
        after: diff.after,
      })
    }
 
    return this.getPatientDetail(hospitalId, hospitalPatientId)
  }

  // ── Patient registration ──────────────────────────────────
  // Looks up an existing app user (PUBLIC or already-PATIENT) so staff can link
  // them to the hospital instead of creating a duplicate account.
  //
  // Deliberately narrow: someone is returned ONLY when the caller types their
  // COMPLETE email address or phone number. Names and partial matches return
  // nothing, so staff cannot browse the platform's user base. Contact details
  // the caller did not type are masked, and every successful lookup is written
  // to the audit log. Also flags anyone already registered at THIS hospital.
  async searchPatientUsers(hospitalId: string, query: string, actorId: string) {
    const q = (query ?? '').trim()
    if (!q) return []

    const byEmail = q.includes('@')
    if (byEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) return []
    const phones = byEmail ? [] : this.phoneVariants(q)
    if (!byEmail && phones.length === 0) return []

    enforceLookupLimit(actorId)

    const users = await this.prisma.user.findMany({
      where: {
        role: { in: [Role.PUBLIC, Role.PATIENT] },
        deletedAt: null,
        ...(byEmail ? { email: { equals: q, mode: 'insensitive' } } : { phone: { in: phones } }),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        avatar: true,
        dateOfBirth: true,
        gender: true,
        hospitalPatients: { select: { hospitalId: true } },
      },
      take: 5,
    })

    // Who looked up whom is recorded; the typed email/number itself is not.
    await Promise.all(
      users.map((u) =>
        this.logAudit({
          hospitalId,
          userId: actorId,
          action: 'VIEW',
          entity: 'PatientLookup',
          entityId: u.id,
          after: { matchedBy: byEmail ? 'email' : 'phone' },
        }),
      ),
    )

    return users.map(({ hospitalPatients, ...u }) => ({
      ...u,
      email: byEmail ? u.email : this.maskEmail(u.email),
      phone: byEmail ? this.maskPhone(u.phone) : u.phone,
      alreadyRegisteredHere: hospitalPatients.some((hp) => hp.hospitalId === hospitalId),
    }))
  }

  // The forms a phone number may be stored in. Nigerian numbers are commonly
  // typed as 0801…, 234801… or +234801…, so all three are tried.
  private phoneVariants(raw: string): string[] {
    const compact = raw.replace(/[\s\-().]/g, '')
    const digits = compact.replace(/^\+/, '')
    if (!/^\d{7,15}$/.test(digits)) return []

    const variants = new Set<string>([compact, digits, `+${digits}`])
    if (digits.startsWith('234') && digits.length === 13) {
      variants.add(`0${digits.slice(3)}`)
    }
    if (digits.startsWith('0') && digits.length === 11) {
      variants.add(`234${digits.slice(1)}`)
      variants.add(`+234${digits.slice(1)}`)
    }
    return [...variants]
  }

  private maskEmail(email: string): string {
    const [local, domain] = email.split('@')
    return `${local.slice(0, 1)}***@${domain}`
  }

  private maskPhone(phone: string | null): string | null {
    return phone ? `${'*'.repeat(Math.max(phone.length - 4, 3))}${phone.slice(-4)}` : null
  }
 
  // Registers a patient at this hospital — either by linking an
  // existing app user (dto.userId set) or creating a brand-new one
  // (dto.firstName/lastName/email set, no userId). Generates the
  // hospital-scoped patient number either way.
  async registerPatient(hospitalId: string, dto: {
    userId?: string
    firstName?: string
    lastName?: string
    email?: string
    phone?: string
    dateOfBirth?: string
    gender?: Gender
    bloodGroup?: BloodGroup
    allergies?: string[]
    chronicConditions?: string[]
    emergencyName?: string
    emergencyPhone?: string
    emergencyRelation?: string
    insuranceProvider?: string
    insuranceNumber?: string
  }, actorId: string) {
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { slug: true },
    })
    if (!hospital) throw new NotFoundException('Hospital not found')
 
    let patientUserId: string
    let temporaryPassword: string | null = null
 
    if (dto.userId) {
      // ── Link an existing app user ──
      const existing = await this.prisma.user.findUnique({ where: { id: dto.userId } })
      if (!existing) throw new NotFoundException('User not found')
 
      const alreadyLinked = await this.prisma.hospitalPatient.findUnique({
        where: { hospitalId_patientId: { hospitalId, patientId: existing.id } },
      })
      if (alreadyLinked) {
        throw new ConflictException('This person is already registered as a patient at your hospital')
      }
 
      if (existing.role === Role.PUBLIC) {
        await this.prisma.user.update({ where: { id: existing.id }, data: { role: Role.PATIENT } })
      }
 
      const hasProfile = await this.prisma.patientProfile.findUnique({ where: { userId: existing.id } })
      if (!hasProfile) {
        await this.prisma.patientProfile.create({
          data: {
            userId: existing.id,
            bloodGroup: dto.bloodGroup ?? BloodGroup.UNKNOWN,
            allergies: dto.allergies ?? [],
            chronicConditions: dto.chronicConditions ?? [],
            emergencyName: dto.emergencyName,
            emergencyPhone: dto.emergencyPhone,
            emergencyRelation: dto.emergencyRelation,
            insuranceProvider: dto.insuranceProvider,
            insuranceNumber: dto.insuranceNumber,
          },
        })
      }
 
      patientUserId = existing.id
    } else {
      // ── Create a brand-new patient account ──
      if (!dto.firstName || !dto.lastName || !dto.email) {
        throw new BadRequestException('First name, last name and email are required to create a new patient')
      }
 
      const existingByEmail = await this.prisma.user.findUnique({ where: { email: String(dto.email).trim().toLowerCase() } })
      if (existingByEmail) {
        throw new ConflictException('A user with this email already exists — search for them instead of creating a new one')
      }
 
      temporaryPassword = crypto.randomBytes(6).toString('hex')
      const passwordHash = await bcrypt.hash(temporaryPassword, 12)
 
      const created = await this.prisma.user.create({
        data: {
          email: String(dto.email).trim().toLowerCase(),
          phone: dto.phone,
          passwordHash,
          role: Role.PATIENT,
          firstName: dto.firstName,
          lastName: dto.lastName,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
          gender: dto.gender,
          hasPassword: true,
          patientProfile: {
            create: {
              bloodGroup: dto.bloodGroup ?? BloodGroup.UNKNOWN,
              allergies: dto.allergies ?? [],
              chronicConditions: dto.chronicConditions ?? [],
              emergencyName: dto.emergencyName,
              emergencyPhone: dto.emergencyPhone,
              emergencyRelation: dto.emergencyRelation,
              insuranceProvider: dto.insuranceProvider,
              insuranceNumber: dto.insuranceNumber,
            },
          },
        },
      })
 
      patientUserId = created.id
    }
 
 
    const hospitalPatient = await this.createHospitalPatient(hospitalId, patientUserId, hospital.slug)
    const patientNumber = hospitalPatient.patientNumber
 
    this.logger.log(`Patient registered: ${patientUserId} (${patientNumber}) at hospital ${hospitalId}`)
 
    await this.logAudit({
        hospitalId,
        userId: actorId,
        action: 'CREATE',
        entity: 'Patient',
        entityId: hospitalPatient.id,
        after: {
          patientNumber,
          patientUserId,
          linkedExistingAccount: !!dto.userId,
        },
      })
  
    return { hospitalPatient, temporaryPassword }
  }

  // Creates the hospital↔patient link with the next free patient number.
  // Two receptionists registering at the same moment could compute the same
  // number; the unique index rejects the second, so we simply try the next one.
  private async createHospitalPatient(hospitalId: string, patientId: string, slug: string) {
    const prefix = `${slug.slice(0, 3).toUpperCase()}-${new Date().getFullYear()}-`
    const existing = await this.prisma.hospitalPatient.count({ where: { hospitalId } })

    for (let attempt = 0; ; attempt++) {
      const patientNumber = `${prefix}${String(existing + 1 + attempt).padStart(5, '0')}`
      try {
        return await this.prisma.hospitalPatient.create({
          data: { hospitalId, patientId, patientNumber, status: HospitalPatientStatus.ACTIVE },
        })
      } catch (err: any) {
        if (err?.code === 'P2002' && attempt < 9) continue
        throw err
      }
    }
  }

  // ── Hospital branding (any staff role) ────────────────────
  async getHospitalBrand(hospitalId: string) {
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { name: true, logo: true },
    })
    if (!hospital) throw new NotFoundException('Hospital not found')
    return hospital
  }

  // ── Front desk: booking, today's queue, check-in ──────────

  // Books an appointment for a patient who is already registered here.
  // `dto.patientId` is the patient's USER id (HospitalPatient.patient.id).
  async createAppointment(
    hospitalId: string,
    dto: {
      patientId?: string
      doctorId?: string
      scheduledAt?: string
      duration?: number
      type?: string
      reason?: string
    },
    actorId: string,
  ) {
    if (!dto.patientId || !dto.doctorId || !dto.scheduledAt) {
      throw new BadRequestException('Patient, doctor and appointment time are required')
    }

    const scheduledAt = new Date(dto.scheduledAt)
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Invalid appointment time')
    }
    // A little grace so a walk-in can be booked for "right now".
    if (scheduledAt.getTime() < Date.now() - 15 * 60 * 1000) {
      throw new BadRequestException('Appointment time cannot be in the past')
    }

    const duration = Math.min(Math.max(Math.round(Number(dto.duration ?? 30)) || 30, 5), 240)
    const type =
      dto.type === AppointmentType.TELEMEDICINE ? AppointmentType.TELEMEDICINE : AppointmentType.IN_PERSON

    const registration = await this.prisma.hospitalPatient.findUnique({
      where: { hospitalId_patientId: { hospitalId, patientId: dto.patientId } },
      select: { status: true },
    })
    if (!registration) {
      throw new NotFoundException('This person is not registered as a patient at your hospital')
    }
    if (registration.status !== HospitalPatientStatus.ACTIVE) {
      throw new BadRequestException('This patient\u2019s record is not active')
    }

    const doctor = await this.prisma.user.findFirst({
      where: { id: dto.doctorId, hospitalId, role: Role.DOCTOR, active: true, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    })
    if (!doctor) throw new NotFoundException('Doctor not found')

    // Refuse a slot that overlaps another of this doctor's appointments.
    const end = new Date(scheduledAt.getTime() + duration * 60 * 1000)
    const windowStart = new Date(scheduledAt.getTime() - 240 * 60 * 1000) // longest possible duration
    const nearby = await this.prisma.appointment.findMany({
      where: {
        hospitalId,
        doctorId: doctor.id,
        deletedAt: null,
        status: { in: ACTIVE_APPOINTMENT_STATUSES },
        scheduledAt: { gte: windowStart, lt: end },
      },
      select: { scheduledAt: true, duration: true },
    })
    const clash = nearby.some(
      (a) => a.scheduledAt.getTime() + a.duration * 60 * 1000 > scheduledAt.getTime(),
    )
    if (clash) {
      throw new ConflictException(
        `Dr ${doctor.firstName} ${doctor.lastName} already has an appointment at this time`,
      )
    }

    const created = await this.prisma.appointment.create({
      data: {
        hospitalId,
        patientId: dto.patientId,
        doctorId: doctor.id,
        type,
        status: AppointmentStatus.CONFIRMED,
        scheduledAt,
        duration,
        reason: dto.reason?.trim() || undefined,
      },
      select: { id: true },
    })

    await this.logAudit({
      hospitalId,
      userId: actorId,
      action: 'CREATE',
      entity: 'Appointment',
      entityId: created.id,
      after: {
        patientId: dto.patientId,
        doctorId: doctor.id,
        scheduledAt: scheduledAt.toISOString(),
        duration,
        type,
      },
    })

    return this.getAppointmentDetail(hospitalId, created.id)
  }

  // The day's appointments in time order, with each patient's hospital
  // number. The client sends its own local day boundaries (`from`/`to`, ISO)
  // so "today" is the hospital's day, not the server's.
  async findQueue(hospitalId: string, from?: string, to?: string) {
    const start = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0))
    const end = to ? new Date(to) : new Date(start.getTime() + 24 * 60 * 60 * 1000)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid date range')
    }

    const appointments = await this.prisma.appointment.findMany({
      where: { hospitalId, deletedAt: null, scheduledAt: { gte: start, lt: end } },
      select: {
        id: true,
        type: true,
        status: true,
        scheduledAt: true,
        duration: true,
        reason: true,
        patient: { select: { id: true, firstName: true, lastName: true, avatar: true, phone: true } },
        doctor: { select: { id: true, firstName: true, lastName: true, department: { select: { name: true } } } },
      },
      orderBy: { scheduledAt: 'asc' },
    })

    const registrations = await this.prisma.hospitalPatient.findMany({
      where: { hospitalId, patientId: { in: appointments.map((a) => a.patient.id) } },
      select: { patientId: true, patientNumber: true },
    })
    const numberOf = new Map(registrations.map((r) => [r.patientId, r.patientNumber]))

    return appointments.map((a) => ({ ...a, patientNumber: numberOf.get(a.patient.id) ?? null }))
  }

  // Marks a patient as arrived. Only booked appointments can be checked in.
  async checkInAppointment(hospitalId: string, id: string, actorId: string) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id, hospitalId, deletedAt: null },
      select: { id: true, status: true },
    })
    if (!appointment) throw new NotFoundException('Appointment not found')

    const checkInAllowed: AppointmentStatus[] = [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED]
    if (!checkInAllowed.includes(appointment.status)) {
      throw new BadRequestException(`Cannot check in an appointment that is ${appointment.status}`)
    }

    await this.prisma.appointment.update({
      where: { id },
      data: { status: AppointmentStatus.CHECKED_IN },
    })

    await this.logAudit({
      hospitalId,
      userId: actorId,
      action: 'UPDATE',
      entity: 'Appointment',
      entityId: id,
      before: { status: appointment.status },
      after: { status: AppointmentStatus.CHECKED_IN },
    })

    return this.getAppointmentDetail(hospitalId, id)
  }

  async findDoctors(hospitalId: string) {
    return this.prisma.user.findMany({
      where: { hospitalId, role: Role.DOCTOR, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        department: { select: { name: true } },
      },
      orderBy: { firstName: 'asc' },
    })
  }
 
  async findAllAppointments(
    hospitalId: string,
    filters: { status?: AppointmentStatus; doctorId?: string; from?: string; to?: string; search?: string },
  ) {
    return this.prisma.appointment.findMany({
      where: {
        hospitalId,
        deletedAt: null,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.doctorId ? { doctorId: filters.doctorId } : {}),
        ...(filters.from || filters.to
          ? {
              scheduledAt: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
        ...(filters.search
          ? {
              OR: [
                { patient: { firstName: { contains: filters.search, mode: 'insensitive' } } },
                { patient: { lastName: { contains: filters.search, mode: 'insensitive' } } },
                { doctor: { firstName: { contains: filters.search, mode: 'insensitive' } } },
                { doctor: { lastName: { contains: filters.search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        type: true,
        status: true,
        scheduledAt: true,
        duration: true,
        reason: true,
        patient: { select: { id: true, firstName: true, lastName: true, avatar: true, phone: true } },
        doctor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatar: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { scheduledAt: 'desc' },
    })
  }
 
  async getAppointmentDetail(hospitalId: string, id: string) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id, hospitalId, deletedAt: null },
      select: {
        id: true,
        type: true,
        status: true,
        scheduledAt: true,
        duration: true,
        reason: true,
        notes: true,
        cancelledAt: true,
        cancelReason: true,
        completedAt: true,
        createdAt: true,
        patient: { select: { id: true, firstName: true, lastName: true, avatar: true, phone: true, email: true } },
        doctor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatar: true,
            department: { select: { name: true } },
          },
        },
      },
    })
    if (!appointment) throw new NotFoundException('Appointment not found')
    return appointment
  }

  async updateAppointment(
    hospitalId: string,
    id: string,
    dto: {
      status?: AppointmentStatus
      scheduledAt?: string
      duration?: number
      cancelReason?: string
      notes?: string
    },
    actorId: string,
  ) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id, hospitalId, deletedAt: null },
    })
    if (!appointment) throw new NotFoundException('Appointment not found')
 
    const data: Record<string, any> = {}
 
    if (dto.status) {
      data.status = dto.status
      if (dto.status === AppointmentStatus.CANCELLED) {
        data.cancelledAt = new Date()
        data.cancelReason = dto.cancelReason ?? appointment.cancelReason
      }
      if (dto.status === AppointmentStatus.COMPLETED) {
        data.completedAt = new Date()
      }
    }
    if (dto.scheduledAt) data.scheduledAt = new Date(dto.scheduledAt)
    if (dto.duration !== undefined) data.duration = dto.duration
    if (dto.notes !== undefined) data.notes = dto.notes
 
    await this.prisma.appointment.update({ where: { id }, data })
 
    // ── Audit: status / reschedule / duration / notes / cancel reason ──
    const beforeSnapshot: Record<string, unknown> = {
      status: appointment.status,
      scheduledAt: appointment.scheduledAt,
      duration: appointment.duration,
      notes: appointment.notes,
      cancelReason: appointment.cancelReason,
    }
    const afterSnapshot: Record<string, unknown> = {}
    for (const key of Object.keys(beforeSnapshot)) {
      if (key in data) afterSnapshot[key] = data[key]
    }
 
    const diff = this.diffForAudit(beforeSnapshot, afterSnapshot)
    if (diff) {
      await this.logAudit({
        hospitalId,
        userId: actorId,
        action: 'UPDATE',
        entity: 'Appointment',
        entityId: id,
        before: diff.before,
        after: diff.after,
      })
    }
 
    return this.getAppointmentDetail(hospitalId, id)
  }


// ── Part 1: a reusable logging helper ──────────────────────
  async logAudit(params: {
    hospitalId: string
    userId: string
    action: string
    entity: string
    entityId: string
    before?: Record<string, any>
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
          before: params.before ?? undefined,
          after: params.after ?? undefined,
          ...auditMeta(),
        },
      })
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${(err as Error).message}`)
    }
  }
 
  // ── Part 2: the viewer's read endpoints ────────────────────
 
  async findAuditEntities(hospitalId: string) {
    const rows = await this.prisma.auditLog.findMany({
      where: { hospitalId },
      distinct: ['entity'],
      select: { entity: true },
      orderBy: { entity: 'asc' },
    })
    return rows.map((r) => r.entity)
  }
 
  async findAuditLogs(
      hospitalId: string,
      filters: { action?: string; entity?: string; search?: string; from?: string; to?: string },
    ) {
      return this.prisma.auditLog.findMany({
        where: {
          hospitalId,
          ...(filters.action ? { action: filters.action } : {}),
          ...(filters.entity ? { entity: filters.entity } : {}),
          ...(filters.from || filters.to
            ? {
                createdAt: {
                  ...(filters.from ? { gte: new Date(filters.from) } : {}),
                  ...(filters.to ? { lte: new Date(filters.to) } : {}),
                },
              }
            : {}),
          ...(filters.search
            ? {
                OR: [
                  { entityId: { contains: filters.search, mode: 'insensitive' } },
                  { user: { firstName: { contains: filters.search, mode: 'insensitive' } } },
                  { user: { lastName: { contains: filters.search, mode: 'insensitive' } } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          action: true,
          entity: true,
          entityId: true,
          before: true,
          after: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
          user: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
    }

}