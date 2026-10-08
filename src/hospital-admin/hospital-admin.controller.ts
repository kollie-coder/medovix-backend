import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards, UseInterceptors, UploadedFile, BadRequestException, Query } from '@nestjs/common'
import { HospitalAdminService } from './hospital-admin.service'
import { FileInterceptor } from '@nestjs/platform-express'
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
 
  // @Post('departments')
  // createDepartment(
  //   @CurrentUser('hospitalId') hospitalId: string,
  //   @Body('name') name: string,
  // ) {
  //   return this.hospitalAdminService.createDepartment(hospitalId, name)
  // }

  @Post('departments')
  createDepartment(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,          // add this
    @Body('name') name: string,
  ) {
    return this.hospitalAdminService.createDepartment(hospitalId, name, actorId)   // pass it through
  }
 
  // @Patch('departments/:id')
  // updateDepartment(
  //   @CurrentUser('hospitalId') hospitalId: string,
  //   @Param('id') id: string,
  //   @Body('name') name: string,
  // ) {
  //   return this.hospitalAdminService.updateDepartment(hospitalId, id, name)
  // }

  @Patch('departments/:id')
  updateDepartment(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,          // add this
    @Param('id') id: string,
    @Body('name') name: string,
  ) {
    return this.hospitalAdminService.updateDepartment(hospitalId, id, name, actorId)
  }
 
  // @Delete('departments/:id')
  // deleteDepartment(
  //   @CurrentUser('hospitalId') hospitalId: string,
  //   @Param('id') id: string,
  // ) {
  //   return this.hospitalAdminService.deleteDepartment(hospitalId, id)
  // }

  @Delete('departments/:id')
  deleteDepartment(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,          // add this
    @Param('id') id: string,
  ) {
    return this.hospitalAdminService.deleteDepartment(hospitalId, id, actorId)
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
    @CurrentUser('id') actorId: string,
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
    return this.hospitalAdminService.inviteStaff(hospitalId, hospital?.name ?? 'your hospital', dto, actorId)
  }
 
  @Patch('staff/:id')
  updateStaff(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: { firstName?: string; lastName?: string; departmentId?: string | null },
  ) {
    return this.hospitalAdminService.updateStaff(hospitalId, id, dto, actorId)
  }
 
  @Patch('staff/:id/active')
  setStaffActive(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body('active') active: boolean,
  ) {
    return this.hospitalAdminService.setStaffActive(hospitalId, id, active, actorId)
  }
 
  @Post('staff/:id/reset-password')
  async resetStaffPassword(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,
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
      actorId,
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
    @CurrentUser('id') actorId: string,
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
    return this.hospitalAdminService.updateHospitalProfile(hospitalId, dto, actorId)
  }

   @Post('hospital/logo')
    @UseInterceptors(FileInterceptor('file'))
    updateHospitalLogo(
      @CurrentUser('hospitalId') hospitalId: string,
      @CurrentUser('id') actorId: string,
      @UploadedFile() file: Express.Multer.File,
    ) {
      if (!file) throw new BadRequestException('No file uploaded')
      return this.hospitalAdminService.updateHospitalLogo(hospitalId, file, actorId)
    }

  @Post('staff/:id/photo')
    @UseInterceptors(FileInterceptor('file'))
    updateStaffPhoto(
      @CurrentUser('hospitalId') hospitalId: string,
      @CurrentUser('id') actorId: string,
      @Param('id') id: string,
      @UploadedFile() file: Express.Multer.File,
    ) {
      if (!file) throw new BadRequestException('No file uploaded')
      return this.hospitalAdminService.updateStaffPhoto(hospitalId, id, file, actorId)
    }

  @Get('patients')
    findAllPatients(
      @CurrentUser('hospitalId') hospitalId: string,
      @Query('search') search?: string,
    ) {
      return this.hospitalAdminService.findAllPatients(hospitalId, search)
    }

  @Patch('patients/:id')
  updatePatientRecord(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: {
      firstName?: string
      lastName?: string
      phone?: string | null
      dateOfBirth?: string | null
      gender?: string | null
      status?: string
      bloodGroup?: string
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
  ) {
    return this.hospitalAdminService.updatePatientRecord(hospitalId, id, dto as any, actorId)
  }

   @Get('patients/search')
    searchPatientUsers(
      @CurrentUser('hospitalId') hospitalId: string,
      @Query('q') q: string,
    ) {
      return this.hospitalAdminService.searchPatientUsers(hospitalId, q)
    }

  @Get('patients/:id')
    getPatientDetail(
      @CurrentUser('hospitalId') hospitalId: string,
      @Param('id') id: string,
    ) {
      return this.hospitalAdminService.getPatientDetail(hospitalId, id)
    }
 
  @Post('patients')
    registerPatient(
      @CurrentUser('hospitalId') hospitalId: string,
      @CurrentUser('id') actorId: string,
      @Body() dto: {
        userId?: string
        firstName?: string
        lastName?: string
        email?: string
        phone?: string
        dateOfBirth?: string
        gender?: string
        bloodGroup?: string
        allergies?: string[]
        chronicConditions?: string[]
        emergencyName?: string
        emergencyPhone?: string
        emergencyRelation?: string
        insuranceProvider?: string
        insuranceNumber?: string
      },
    ) {
      return this.hospitalAdminService.registerPatient(hospitalId, dto as any, actorId)
    }


  @Get('appointments/doctors')
    findDoctors(@CurrentUser('hospitalId') hospitalId: string) {
      return this.hospitalAdminService.findDoctors(hospitalId)
    }
 
  @Get('appointments')
    findAllAppointments(
      @CurrentUser('hospitalId') hospitalId: string,
      @Query('status') status?: string,
      @Query('doctorId') doctorId?: string,
      @Query('from') from?: string,
      @Query('to') to?: string,
      @Query('search') search?: string,
    ) {
      return this.hospitalAdminService.findAllAppointments(hospitalId, {
        status: status as any,
        doctorId,
        from,
        to,
        search,
      })
    }
 
  @Get('appointments/:id')
    getAppointmentDetail(
      @CurrentUser('hospitalId') hospitalId: string,
      @Param('id') id: string,
    ) {
      return this.hospitalAdminService.getAppointmentDetail(hospitalId, id)
    }
 
  @Patch('appointments/:id')
  updateAppointment(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: {
      status?: string
      scheduledAt?: string
      duration?: number
      cancelReason?: string
      notes?: string
    },
  ) {
    return this.hospitalAdminService.updateAppointment(hospitalId, id, dto as any, actorId)
  }

  @Get('billing/stats')
    getBillingStats(@CurrentUser('hospitalId') hospitalId: string) {
      return this.hospitalAdminService.getBillingStats(hospitalId)
    }
 
  @Get('billing')
    findAllBills(
      @CurrentUser('hospitalId') hospitalId: string,
      @Query('status') status?: string,
      @Query('search') search?: string,
    ) {
      return this.hospitalAdminService.findAllBills(hospitalId, { status: status as any, search })
    }
 
  @Get('billing/:id')
    getBillDetail(
      @CurrentUser('hospitalId') hospitalId: string,
      @Param('id') id: string,
    ) {
      return this.hospitalAdminService.getBillDetail(hospitalId, id)
    }
 
   @Post('billing/:id/payments')
    recordPayment(
      @CurrentUser('hospitalId') hospitalId: string,
      @CurrentUser('id') actorId: string,
      @Param('id') id: string,
      @Body() dto: { amount: number; method: string; reference?: string },
    ) {
      return this.hospitalAdminService.recordPayment(hospitalId, id, dto, actorId)
    }

  @Get('audit-log/entities')
    findAuditEntities(@CurrentUser('hospitalId') hospitalId: string) {
      return this.hospitalAdminService.findAuditEntities(hospitalId)
    }
 
  @Get('audit-log')
    findAuditLogs(
      @CurrentUser('hospitalId') hospitalId: string,
      @Query('action') action?: string,
      @Query('entity') entity?: string,
      @Query('search') search?: string,
      @Query('from') from?: string,
      @Query('to') to?: string,
    ) {
      return this.hospitalAdminService.findAuditLogs(hospitalId, { action, entity, search, from, to })
    } 
}