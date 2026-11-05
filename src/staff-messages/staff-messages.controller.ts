import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { Role } from '@prisma/client'
import { Throttle } from '@nestjs/throttler'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { HospitalScopeGuard } from '../auth/guards/hospital-scope.guard'
import { Roles } from '../auth/decorators/roles.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { MESSAGING_ROLES, StaffMessagesService } from './staff-messages.service'
import { CreateStaffMessageDto, ReplyStaffMessageDto } from './staff-messages.dto'

// Messages between colleagues about a patient's visit. Staff only, same hospital only.
@Controller('staff-messages')
@UseGuards(JwtAuthGuard, RolesGuard, HospitalScopeGuard)
@Roles(...MESSAGING_ROLES)
export class StaffMessagesController {
  constructor(private messages: StaffMessagesService) {}

  @Get()
  list(
    @CurrentUser('id') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('box') box?: string,
    @Query('page') page?: string,
  ) {
    return this.messages.list(userId, hospitalId, box === 'sent' ? 'sent' : 'inbox', page ? parseInt(page, 10) : 1)
  }

  @Get('unread-count')
  unreadCount(@CurrentUser('id') userId: string, @CurrentUser('hospitalId') hospitalId: string) {
    return this.messages.unreadCount(userId, hospitalId)
  }

  @Get('recipients')
  recipients(@CurrentUser('id') userId: string, @CurrentUser('hospitalId') hospitalId: string) {
    return this.messages.recipients(userId, hospitalId)
  }

  @Get('appointments/:appointmentId')
  forAppointment(
    @CurrentUser('id') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Param('appointmentId') appointmentId: string,
  ) {
    return this.messages.forAppointment(userId, hospitalId, appointmentId)
  }

  // Only doctors start a conversation, from one of their own visits.
  @Post()
  @Roles(Role.DOCTOR)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Body() dto: CreateStaffMessageDto,
  ) {
    return this.messages.create(userId, role, hospitalId, dto)
  }

  // Declared before ':id/...' so "read-all" is not taken as an id.
  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentUser('id') userId: string, @CurrentUser('hospitalId') hospitalId: string) {
    return this.messages.markAllRead(userId, hospitalId)
  }

  @Post(':id/reply')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  reply(
    @CurrentUser('id') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Param('id') id: string,
    @Body() dto: ReplyStaffMessageDto,
  ) {
    return this.messages.reply(userId, hospitalId, id, dto.body)
  }

  @Post(':id/read')
  @HttpCode(200)
  read(
    @CurrentUser('id') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Param('id') id: string,
  ) {
    return this.messages.markRead(userId, hospitalId, id)
  }
}
