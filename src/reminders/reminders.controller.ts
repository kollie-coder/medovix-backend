// src/reminders/reminders.controller.ts
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, UseGuards,
} from '@nestjs/common'
import { RemindersService } from './reminders.service'
import { CreateReminderDto } from './dto/create-reminder.dto'
import { UpdateReminderDto } from './dto/update-reminder.dto'
import { MarkDoseDto } from './dto/mark-dose.dto'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'

@Controller('reminders')
@UseGuards(JwtAuthGuard) // all reminder routes require login
export class RemindersController {
  constructor(private remindersService: RemindersService) {}

  // GET /api/v1/reminders
  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.remindersService.findAll(userId)
  }

  // GET /api/v1/reminders/today
  @Get('today')
  getTodaySummary(@CurrentUser('id') userId: string) {
    return this.remindersService.getTodaySummary(userId)
  }

  // POST /api/v1/reminders
  @Post()
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateReminderDto,
  ) {
    return this.remindersService.create(userId, dto)
  }

  // PATCH /api/v1/reminders/:id
  @Patch(':id')
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateReminderDto,
  ) {
    return this.remindersService.update(userId, id, dto)
  }

  // DELETE /api/v1/reminders/:id
  @Delete(':id')
  remove(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.remindersService.remove(userId, id)
  }

  // POST /api/v1/reminders/:id/doses
  @Post(':id/doses')
  markDose(
    @CurrentUser('id') userId: string,
    @Param('id') reminderId: string,
    @Body() dto: MarkDoseDto,
  ) {
    return this.remindersService.markDose(userId, reminderId, dto)
  }
}