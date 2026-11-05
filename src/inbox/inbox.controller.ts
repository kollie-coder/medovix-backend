import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common'
import { Role } from '@prisma/client'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { HospitalScopeGuard } from '../auth/guards/hospital-scope.guard'
import { Roles } from '../auth/decorators/roles.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { InboxService } from './inbox.service'

// The doctor's results inbox: lab results, cancelled tests and declined prescriptions.
@Controller('inbox')
@UseGuards(JwtAuthGuard, RolesGuard, HospitalScopeGuard)
@Roles(Role.DOCTOR)
export class InboxController {
  constructor(private inbox: InboxService) {}

  @Get()
  list(
    @CurrentUser('id') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('filter') filter?: string,
    @Query('page') page?: string,
  ) {
    return this.inbox.list(userId, hospitalId, filter === 'all' ? 'all' : 'unread', page ? parseInt(page, 10) : 1)
  }

  @Get('unread-count')
  unreadCount(@CurrentUser('id') userId: string) {
    return this.inbox.unreadCount(userId)
  }

  // Declared before ':id/read' so "read-all" is not taken as an id.
  @Post('read-all')
  readAll(@CurrentUser('id') userId: string) {
    return this.inbox.markAllRead(userId)
  }

  @Post(':id/read')
  read(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.inbox.markRead(userId, id)
  }
}
