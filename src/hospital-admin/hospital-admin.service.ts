import { Injectable, NotFoundException, ConflictException, ForbiddenException, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { EmailService } from 'src/email/email.service'
import { Role } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'


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
 
  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
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
 
  async createDepartment(hospitalId: string, name: string) {
    const existing = await this.prisma.department.findFirst({
      where: { hospitalId, name: { equals: name, mode: 'insensitive' }, deletedAt: null },
    })
    if (existing) {
      throw new ConflictException('A department with this name already exists')
    }
 
    return this.prisma.department.create({
      data: { hospitalId, name },
    })
  }
 
  async updateDepartment(hospitalId: string, departmentId: string, name: string) {
    const department = await this.prisma.department.findFirst({
      where: { id: departmentId, hospitalId, deletedAt: null },
    })
    if (!department) throw new NotFoundException('Department not found')
 
    return this.prisma.department.update({
      where: { id: departmentId },
      data: { name },
    })
  }
 
  async deleteDepartment(hospitalId: string, departmentId: string) {
    const department = await this.prisma.department.findFirst({
      where: { id: departmentId, hospitalId, deletedAt: null },
    })
    if (!department) throw new NotFoundException('Department not found')
 
    await this.prisma.department.update({
      where: { id: departmentId },
      data: { deletedAt: new Date() },
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
        active: true, department: { select: { id: true, name: true } }, createdAt: true,
      },
    })
    if (!staff) throw new NotFoundException('Staff member not found')
    return staff
  }
 
 async inviteStaff(hospitalId: string, hospitalName: string, dto: {
    firstName: string
    lastName: string
    email: string
    role: Role
    departmentId?: string
  }) {
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

    // NEW: check the hospital's invite-mode toggle
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

    // NEW: only email if the hospital has it enabled (default true)
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

    return { staff, temporaryPassword: tempPassword, emailSent }
  }
 
  // Edit an existing staff member's name/department (not email or role —
  // changing those is significant enough to warrant a more deliberate
  // flow later, e.g. re-verification, rather than a quick inline edit)
  async updateStaff(hospitalId: string, staffId: string, dto: {
    firstName?: string
    lastName?: string
    departmentId?: string | null
  }) {
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
 
    return this.prisma.user.update({
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
  }
 
  async setStaffActive(hospitalId: string, staffId: string, active: boolean) {
    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, hospitalId, role: { in: INVITABLE_STAFF_ROLES } },
    })
    if (!staff) throw new NotFoundException('Staff member not found')
 
    return this.prisma.user.update({
      where: { id: staffId },
      data: { active },
    })
  }
 
  // Admin-triggered password reset — generates a fresh temp password and
  // emails it to the staff member, same pattern as the initial invite.
  async resetStaffPassword(
    hospitalId: string,
    staffId: string,
    hospitalName: string,
    emailInvitesEnabled: boolean,
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
 
  async updateHospitalProfile(hospitalId: string, dto: {
    name?: string
    address?: string
    city?: string
    state?: string
    phone?: string
    website?: string
    logo?: string
    emailInvitesEnabled?: boolean
  }) {
    return this.prisma.hospital.update({
      where: { id: hospitalId },
      data: dto,
      select: {
        id: true, name: true, type: true, address: true, city: true,
        state: true, country: true, phone: true, email: true, website: true,
        logo: true, verified: true, plan: true, planStatus: true,
        emailInvitesEnabled: true,
      },
    })
  }
}