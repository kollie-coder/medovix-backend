import { Injectable, NotFoundException, ConflictException, ForbiddenException, Logger, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { EmailService } from 'src/email/email.service'
import { Role, Gender, BloodGroup, HospitalPatientStatus, AppointmentStatus, BillStatus } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { StorageService } from 'src/storage/storage.service'


// The only roles a Hospital Admin is allowed to create — deliberately
// excludes ADMIN and SUPER_ADMIN. A hospital admin should never be able
// to create another admin for their own hospital (that stays a Super
// Admin action) or, obviously, a platform-level Super Admin account.
const INVITABLE_STAFF_ROLES: Role[] = [
  Role.DOCTOR, Role.NURSE, Role.PHARMACIST, Role.LAB_TECHNICIAN, Role.DIETICIAN,
]
 
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
    },
    actorId: string,
  ) {
    if (!INVITABLE_STAFF_ROLES.includes(dto.role)) {
      throw new ForbiddenException('You are not permitted to create a staff account with this role')
    }
 
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } })
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
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        passwordHash,
        role: dto.role,
        hospitalId,
        departmentId: dto.departmentId,
        emailVerified: false,
        hasPassword: true,
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
    },
    actorId: string,
  ) {
    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, hospitalId, role: { in: INVITABLE_STAFF_ROLES } },
    })
    if (!staff) throw new NotFoundException('Staff member not found')
 
    if (dto.departmentId) {
      const department = await this.prisma.department.findFirst({
        where: { id: dto.departmentId, hospitalId, deletedAt: null },
      })
      if (!department) throw new NotFoundException('Department not found')
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
      },
    })
 
    // ── Audit: only the fields that actually changed ──
    const beforeSnapshot: Record<string, unknown> = {
      firstName: staff.firstName,
      lastName: staff.lastName,
      departmentId: staff.departmentId,
    }
    const afterSnapshot: Record<string, unknown> = {}
    if (dto.firstName !== undefined) afterSnapshot.firstName = dto.firstName
    if (dto.lastName !== undefined) afterSnapshot.lastName = dto.lastName
    if (dto.departmentId !== undefined) afterSnapshot.departmentId = dto.departmentId
 
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
  // Search existing app users (PUBLIC or already-PATIENT) by name,
  // email or phone, so staff can link an existing account instead of
  // creating a duplicate. Flags anyone already registered at THIS
  // hospital so the UI can disable re-registering them.
  async searchPatientUsers(hospitalId: string, query: string) {
    if (!query || query.trim().length < 2) return []
 
    const users = await this.prisma.user.findMany({
      where: {
        role: { in: [Role.PUBLIC, Role.PATIENT] },
        deletedAt: null,
        OR: [
          { email: { contains: query, mode: 'insensitive' } },
          { phone: { contains: query, mode: 'insensitive' } },
          { firstName: { contains: query, mode: 'insensitive' } },
          { lastName: { contains: query, mode: 'insensitive' } },
        ],
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
      take: 10,
    })
 
    return users.map(({ hospitalPatients, ...u }) => ({
      ...u,
      alreadyRegisteredHere: hospitalPatients.some((hp) => hp.hospitalId === hospitalId),
    }))
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
 
      const existingByEmail = await this.prisma.user.findUnique({ where: { email: dto.email } })
      if (existingByEmail) {
        throw new ConflictException('A user with this email already exists — search for them instead of creating a new one')
      }
 
      temporaryPassword = crypto.randomBytes(6).toString('hex')
      const passwordHash = await bcrypt.hash(temporaryPassword, 12)
 
      const created = await this.prisma.user.create({
        data: {
          email: dto.email,
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
 
    const count = await this.prisma.hospitalPatient.count({ where: { hospitalId } })
    const patientNumber = `${hospital.slug.slice(0, 3).toUpperCase()}-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`
 
    const hospitalPatient = await this.prisma.hospitalPatient.create({
      data: {
        hospitalId,
        patientId: patientUserId,
        patientNumber,
        status: HospitalPatientStatus.ACTIVE,
      },
    })
 
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


  // ── Billing overview ──────────────────────────────────────
 
  async getBillingStats(hospitalId: string) {
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
 
    const [outstandingAgg, collectedThisMonth, overdueCount] = await Promise.all([
      this.prisma.bill.aggregate({
        where: { hospitalId, deletedAt: null, status: { in: [BillStatus.PENDING, BillStatus.PARTIAL, BillStatus.OVERDUE] } },
        _sum: { totalAmount: true, amountPaid: true },
      }),
      this.prisma.payment.aggregate({
        where: { bill: { hospitalId, deletedAt: null }, paidAt: { gte: startOfMonth } },
        _sum: { amount: true },
      }),
      this.prisma.bill.count({
        where: { hospitalId, deletedAt: null, status: { in: [BillStatus.PENDING, BillStatus.PARTIAL] }, dueDate: { lt: now } },
      }),
    ])
 
    const outstanding = (outstandingAgg._sum.totalAmount ?? 0) - (outstandingAgg._sum.amountPaid ?? 0)
 
    return {
      outstanding,
      collectedThisMonth: collectedThisMonth._sum.amount ?? 0,
      overdueCount,
    }
  }
 
  async findAllBills(hospitalId: string, filters: { status?: BillStatus; search?: string }) {
    let patientIds: string[] | undefined
 
    if (filters.search) {
      const matchingUsers = await this.prisma.user.findMany({
        where: {
          OR: [
            { firstName: { contains: filters.search, mode: 'insensitive' } },
            { lastName: { contains: filters.search, mode: 'insensitive' } },
            { email: { contains: filters.search, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      })
      patientIds = matchingUsers.map((u) => u.id)
    }
 
    const bills = await this.prisma.bill.findMany({
      where: {
        hospitalId,
        deletedAt: null,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.search
          ? {
              OR: [
                { invoiceNo: { contains: filters.search, mode: 'insensitive' } },
                ...(patientIds && patientIds.length ? [{ patientId: { in: patientIds } }] : []),
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    })
 
    const patients = await this.prisma.user.findMany({
      where: { id: { in: bills.map((b) => b.patientId) } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    })
    const patientMap = new Map(patients.map((p) => [p.id, p]))
 
    return bills.map((b) => ({ ...b, patient: patientMap.get(b.patientId) ?? null }))
  }
 
  async getBillDetail(hospitalId: string, billId: string) {
    const bill = await this.prisma.bill.findFirst({
      where: { id: billId, hospitalId, deletedAt: null },
      include: {
        items: true,
        payments: { orderBy: { paidAt: 'desc' } },
      },
    })
    if (!bill) throw new NotFoundException('Bill not found')
 
    const patient = await this.prisma.user.findUnique({
      where: { id: bill.patientId },
      select: { id: true, firstName: true, lastName: true, avatar: true, email: true, phone: true },
    })
 
    return { ...bill, patient }
  }
 
  async recordPayment(
    hospitalId: string,
    billId: string,
    dto: { amount: number; method: string; reference?: string },
    actorId: string,
  ) {
    const bill = await this.prisma.bill.findFirst({ where: { id: billId, hospitalId, deletedAt: null } })
    if (!bill) throw new NotFoundException('Bill not found')
    if (!dto.amount || dto.amount <= 0) throw new BadRequestException('Payment amount must be greater than zero')
 
    const payment = await this.prisma.payment.create({
      data: { billId, amount: dto.amount, method: dto.method, reference: dto.reference },
    })
 
    const newAmountPaid = bill.amountPaid + dto.amount
    let status: BillStatus = bill.status
    if (newAmountPaid >= bill.totalAmount) status = BillStatus.PAID
    else if (newAmountPaid > 0) status = BillStatus.PARTIAL
 
    await this.prisma.bill.update({
      where: { id: billId },
      data: {
        amountPaid: newAmountPaid,
        status,
        paidAt: status === BillStatus.PAID ? new Date() : bill.paidAt,
      },
    })
 
    // Logged as a CREATE on the Payment (the thing that was actually
    // created), with the bill's balance/status movement alongside so the
    // viewer shows exactly what the payment did to the invoice.
    await this.logAudit({
      hospitalId,
      userId: actorId,
      action: 'CREATE',
      entity: 'Payment',
      entityId: payment.id,
      before: { invoiceNo: bill.invoiceNo, billAmountPaid: bill.amountPaid, billStatus: bill.status },
      after: {
        invoiceNo: bill.invoiceNo,
        amount: dto.amount,
        method: dto.method,
        reference: dto.reference ?? null,
        billAmountPaid: newAmountPaid,
        billStatus: status,
      },
    })
 
    return this.getBillDetail(hospitalId, billId)
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
          createdAt: true,
          user: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
    }

}