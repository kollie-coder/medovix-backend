import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common'
import { HospitalAdminService } from './hospital-admin.service'
import { PrismaService } from '../prisma/prisma.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { Roles } from '../auth/decorators/roles.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Role } from '@prisma/client'
 
@Controller('hospital-admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class HospitalAdminController {
  constructor(
    private hospitalAdminService: HospitalAdminService,
    private prisma: PrismaService,
  ) {}
 
  @Get('stats')
  getStats(@CurrentUser('hospitalId') hospitalId: string) {
    return this.hospitalAdminService.getStats(hospitalId)
  }
 
  // ── Departments ──────────────────────────────────────────
  @Get('departments')
  findAllDepartments(@CurrentUser('hospitalId') hospitalId: string) {
    return this.hospitalAdminService.findAllDepartments(hospitalId)
  }
 
  @Get('departments/:id')
  getDepartmentDetail(
    @CurrentUser('hospitalId') hospitalId: string,
    @Param('id') id: string,
  ) {
    return this.hospitalAdminService.getDepartmentDetail(hospitalId, id)
  }
 
  @Post('departments')
  createDepartment(
    @CurrentUser('hospitalId') hospitalId: string,
    @Body('name') name: string,
  ) {
    return this.hospitalAdminService.createDepartment(hospitalId, name)
  }
 
  @Patch('departments/:id')
  updateDepartment(
    @CurrentUser('hospitalId') hospitalId: string,
    @Param('id') id: string,
    @Body('name') name: string,
  ) {
    return this.hospitalAdminService.updateDepartment(hospitalId, id, name)
  }
 
  @Delete('departments/:id')
  deleteDepartment(
    @CurrentUser('hospitalId') hospitalId: string,
    @Param('id') id: string,
  ) {
    return this.hospitalAdminService.deleteDepartment(hospitalId, id)
  }
 
  // ── Staff ────────────────────────────────────────────────
  @Get('staff')
  findAllStaff(@CurrentUser('hospitalId') hospitalId: string) {
    return this.hospitalAdminService.findAllStaff(hospitalId)
  }
 
  @Get('staff/:id')
  getStaffDetail(
    @CurrentUser('hospitalId') hospitalId: string,
    @Param('id') id: string,
  ) {
    return this.hospitalAdminService.getStaffDetail(hospitalId, id)
  }
 
  @Post('staff')
  async inviteStaff(
    @CurrentUser('hospitalId') hospitalId: string,
    @Body() dto: {
      firstName: string
      lastName: string
      email: string
      role: Role
      departmentId?: string
    },
  ) {
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { name: true },
    })
    return this.hospitalAdminService.inviteStaff(hospitalId, hospital?.name ?? 'your hospital', dto)
  }
 
  @Patch('staff/:id')
  updateStaff(
    @CurrentUser('hospitalId') hospitalId: string,
    @Param('id') id: string,
    @Body() dto: { firstName?: string; lastName?: string; departmentId?: string | null },
  ) {
    return this.hospitalAdminService.updateStaff(hospitalId, id, dto)
  }
 
  @Patch('staff/:id/active')
  setStaffActive(
    @CurrentUser('hospitalId') hospitalId: string,
    @Param('id') id: string,
    @Body('active') active: boolean,
  ) {
    return this.hospitalAdminService.setStaffActive(hospitalId, id, active)
  }
 
  @Post('staff/:id/reset-password')
  async resetStaffPassword(
    @CurrentUser('hospitalId') hospitalId: string,
    @Param('id') id: string,
  ) {
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { name: true, emailInvitesEnabled: true },
    })
    return this.hospitalAdminService.resetStaffPassword(
      hospitalId,
      id,
      hospital?.name ?? 'your hospital',
      hospital?.emailInvitesEnabled ?? true,
    )
  }
 
  // ── Hospital profile ─────────────────────────────────────
  @Get('hospital')
  getHospitalProfile(@CurrentUser('hospitalId') hospitalId: string) {
    return this.hospitalAdminService.getHospitalProfile(hospitalId)
  }
 
  @Patch('hospital')
  updateHospitalProfile(
    @CurrentUser('hospitalId') hospitalId: string,
    @Body() dto: {
      name?: string
      address?: string
      city?: string
      state?: string
      phone?: string
      website?: string
      logo?: string
    },
  ) {
    return this.hospitalAdminService.updateHospitalProfile(hospitalId, dto)
  }
}