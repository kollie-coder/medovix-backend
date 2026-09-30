// src/super-admin/super-admin.service.ts
import { Injectable, ConflictException, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { EmailService } from 'src/email/email.service'
import { Role, HospitalType } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'

@Injectable()
export class SuperAdminService {
  private readonly logger = new Logger(SuperAdminService.name)

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
  ) {}

  // ── Onboard a new hospital + create its first Admin account ──
  // Done as a single atomic transaction: if either half fails, neither
  // is created — you never end up with an orphaned hospital that has
  // no one able to log in and manage it, or an admin account with no
  // hospital attached.
  async onboardHospital(dto: {
    hospitalName: string
    type: HospitalType
    address: string
    city: string
    state: string
    country?: string
    phone: string
    hospitalEmail: string
    website?: string
    adminFirstName: string
    adminLastName: string
    adminEmail: string
  }) {
    const existingHospital = await this.prisma.hospital.findUnique({
      where: { email: dto.hospitalEmail },
    })
    if (existingHospital) {
      throw new ConflictException('A hospital with this email already exists')
    }
 
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.adminEmail },
    })
    if (existingUser) {
      throw new ConflictException('A user with this admin email already exists')
    }
 
    const tempPassword = crypto.randomBytes(6).toString('hex')
    const passwordHash = await bcrypt.hash(tempPassword, 12)
 
    const slug = dto.hospitalName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
 
    const result = await this.prisma.$transaction(async tx => {
      const hospital = await tx.hospital.create({
        data: {
          name: dto.hospitalName,
          slug,
          type: dto.type,
          address: dto.address,
          city: dto.city,
          state: dto.state,
          country: dto.country ?? 'Nigeria',
          phone: dto.phone,
          email: dto.hospitalEmail,
          website: dto.website,
          active: true,
        },
      })
 
      const admin = await tx.user.create({
        data: {
          email: dto.adminEmail,
          firstName: dto.adminFirstName,
          lastName: dto.adminLastName,
          passwordHash,
          role: Role.ADMIN,
          hospitalId: hospital.id,
          emailVerified: false,
          hasPassword: true,
        },
        select: {
          id: true, email: true, firstName: true, lastName: true, role: true,
        },
      })
 
      return { hospital, admin }
    })
 
    this.logger.log(`Onboarded new hospital: ${result.hospital.name} (${result.hospital.id})`)
 
    // Send the credentials by email — failure here doesn't undo the
    // hospital/admin creation, since the temporary password is also
    // returned in the response as a fallback the Super Admin can share
    // manually if the email happens to fail.
    const emailSent = await this.emailService.sendStaffInviteEmail(
      result.admin.email,
      `${result.admin.firstName} ${result.admin.lastName}`,
      result.hospital.name,
      'Admin',
      tempPassword,
    )
 
    return {
      hospital: result.hospital,
      admin: result.admin,
      temporaryPassword: tempPassword,
      emailSent,
    }
  }

  // ── List every hospital on the platform ─────────────────────
  async findAllHospitals() {
    const hospitals = await this.prisma.hospital.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        type: true,
        city: true,
        state: true,
        active: true,
        verified: true,
        plan: true,
        planStatus: true,
        createdAt: true,
        _count: { select: { staff: true, patients: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return hospitals
  }

  // ── Toggle a hospital's active status (suspend/reactivate) ──
  async setHospitalActive(hospitalId: string, active: boolean) {
    return this.prisma.hospital.update({
      where: { id: hospitalId },
      data: { active },
    })
  }

  // ── Platform-wide stats for the Super Admin dashboard ────────
  async getPlatformStats() {
    const [hospitalCount, activeHospitalCount, totalStaff, totalPatients] = await Promise.all([
      this.prisma.hospital.count({ where: { deletedAt: null } }),
      this.prisma.hospital.count({ where: { deletedAt: null, active: true } }),
      this.prisma.user.count({
        where: { role: { in: ['ADMIN', 'DOCTOR', 'NURSE', 'PHARMACIST', 'LAB_TECHNICIAN', 'DIETICIAN'] } },
      }),
      this.prisma.hospitalPatient.count(),
    ])
 
    return { hospitalCount, activeHospitalCount, totalStaff, totalPatients }
  }
}