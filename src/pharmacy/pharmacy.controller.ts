import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { Role } from '@prisma/client'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { HospitalScopeGuard } from '../auth/guards/hospital-scope.guard'
import { Roles } from '../auth/decorators/roles.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { PharmacyService } from './pharmacy.service'
import { DeclineDto, DispenseDto } from './pharmacy.dto'

@Controller('pharmacy')
@UseGuards(JwtAuthGuard, RolesGuard, HospitalScopeGuard)
@Roles(Role.PHARMACIST)
export class PharmacyController {
  constructor(private pharmacy: PharmacyService) {}

  @Get('prescriptions')
  list(@CurrentUser('hospitalId') hospitalId: string, @Query('view') view?: string) {
    return this.pharmacy.list(hospitalId, view)
  }

  @Post('prescriptions/:id/dispense')
  @HttpCode(200)
  dispense(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') pharmacistId: string,
    @Param('id') id: string,
    @Body() dto: DispenseDto,
  ) {
    return this.pharmacy.dispense(hospitalId, pharmacistId, id, dto)
  }

  @Post('prescriptions/:id/decline')
  @HttpCode(200)
  decline(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') pharmacistId: string,
    @Param('id') id: string,
    @Body() dto: DeclineDto,
  ) {
    return this.pharmacy.decline(hospitalId, pharmacistId, id, dto)
  }
}
