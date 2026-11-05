import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common'
import { Role } from '@prisma/client'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { HospitalScopeGuard } from '../auth/guards/hospital-scope.guard'
import { Roles } from '../auth/decorators/roles.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SchedulingService } from './scheduling.service'
import { FollowUpDto, InternalReferralDto } from './scheduling.dto'

// Follow-up bookings, referrals to colleagues, and the doctor's diary.
@Controller('scheduling')
@UseGuards(JwtAuthGuard, RolesGuard, HospitalScopeGuard)
@Roles(Role.DOCTOR)
export class SchedulingController {
  constructor(private scheduling: SchedulingService) {}

  @Get('doctors')
  doctors(@CurrentUser('hospitalId') hospitalId: string, @CurrentUser('id') meId: string) {
    return this.scheduling.listDoctors(hospitalId, meId)
  }

  @Get('busy')
  busy(
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('doctorId') doctorId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.scheduling.busy(hospitalId, doctorId, from, to)
  }

  @Get('schedule')
  schedule(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.scheduling.schedule(hospitalId, doctorId, from, to)
  }

  @Post('appointments/:id/follow-up')
  followUp(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
    @Body() dto: FollowUpDto,
  ) {
    return this.scheduling.followUp(hospitalId, doctorId, id, dto)
  }

  @Post('appointments/:id/refer')
  refer(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
    @Body() dto: InternalReferralDto,
  ) {
    return this.scheduling.refer(hospitalId, doctorId, id, dto)
  }
}
