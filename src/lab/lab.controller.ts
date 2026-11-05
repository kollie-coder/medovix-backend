import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { Role } from '@prisma/client'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { HospitalScopeGuard } from '../auth/guards/hospital-scope.guard'
import { Roles } from '../auth/decorators/roles.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { LabService } from './lab.service'
import { CancelOrderDto, CorrectionDto, EnterResultDto } from './lab.dto'

@Controller('lab')
@UseGuards(JwtAuthGuard, RolesGuard, HospitalScopeGuard)
@Roles(Role.LAB_TECHNICIAN)
export class LabController {
  constructor(private lab: LabService) {}

  @Get('orders')
  list(@CurrentUser('hospitalId') hospitalId: string, @Query('view') view?: string) {
    return this.lab.list(hospitalId, view)
  }

  @Post('orders/:id/collect-sample')
  @HttpCode(200)
  collect(@CurrentUser('hospitalId') hospitalId: string, @CurrentUser('id') actorId: string, @Param('id') id: string) {
    return this.lab.collectSample(hospitalId, actorId, id)
  }

  @Post('orders/:id/start')
  @HttpCode(200)
  start(@CurrentUser('hospitalId') hospitalId: string, @CurrentUser('id') actorId: string, @Param('id') id: string) {
    return this.lab.start(hospitalId, actorId, id)
  }

  @Post('orders/:id/result')
  result(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: EnterResultDto,
  ) {
    return this.lab.enterResult(hospitalId, actorId, id, dto)
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.lab.cancel(hospitalId, actorId, id, dto)
  }

  @Post('orders/:id/correction')
  correction(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: CorrectionDto,
  ) {
    return this.lab.addCorrection(hospitalId, actorId, id, dto)
  }
}
