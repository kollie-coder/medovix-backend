import { Controller, Get, Post, Patch, Param, Body, UseGuards } from '@nestjs/common'
import { SuperAdminService } from './super-admin.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard, Roles } from '../auth/guards/roles.guard'
import { Role, HospitalType } from '@prisma/client'

@Controller('super-admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class SuperAdminController {
  constructor(private superAdminService: SuperAdminService) {}

  @Post('hospitals')
  onboardHospital(@Body() dto: {
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
    return this.superAdminService.onboardHospital(dto)
  }

  @Get('hospitals')
  findAllHospitals() {
    return this.superAdminService.findAllHospitals()
  }

  @Patch('hospitals/:id/active')
  setHospitalActive(
    @Param('id') id: string,
    @Body('active') active: boolean,
  ) {
    return this.superAdminService.setHospitalActive(id, active)
  }

  @Get('stats')
  getPlatformStats() {
    return this.superAdminService.getPlatformStats()
  }
}