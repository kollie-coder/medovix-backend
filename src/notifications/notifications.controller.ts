import { Controller, Get, Post, Patch, Body, Delete, Param, Query, UseGuards } from '@nestjs/common'
import { NotificationsService } from './notifications.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Get()
  findAll(
    @CurrentUser('id') userId: string,
    @Query() query: { page?: string; limit?: string },
  ) {
    return this.notificationsService.findAll(userId, query)
  }

  @Post()
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: { title: string; body: string; type: string; data?: any },
  ) {
    return this.notificationsService.create(userId, dto)
  }

  @Get('unread-count')
  getUnreadCount(@CurrentUser('id') userId: string) {
    return this.notificationsService.getUnreadCount(userId)
  }

  @Patch(':id/read')
  markAsRead(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.notificationsService.markAsRead(userId, id)
  }

  @Patch('read-all')
  markAllAsRead(@CurrentUser('id') userId: string) {
    return this.notificationsService.markAllAsRead(userId)
  }

  @Delete(':id')
  remove(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.notificationsService.remove(userId, id)
  }
}