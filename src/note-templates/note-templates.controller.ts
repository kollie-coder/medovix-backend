import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { Role } from '@prisma/client'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { HospitalScopeGuard } from '../auth/guards/hospital-scope.guard'
import { Roles } from '../auth/decorators/roles.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { NoteTemplatesService } from './note-templates.service'
import { CreateNoteTemplateDto } from './note-templates.dto'

@Controller('note-templates')
@UseGuards(JwtAuthGuard, RolesGuard, HospitalScopeGuard)
@Roles(Role.DOCTOR)
export class NoteTemplatesController {
  constructor(private templates: NoteTemplatesService) {}

  @Get()
  list(@CurrentUser('id') userId: string, @CurrentUser('hospitalId') hospitalId: string) {
    return this.templates.list(userId, hospitalId)
  }

  @Post()
  create(
    @CurrentUser('id') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Body() dto: CreateNoteTemplateDto,
  ) {
    return this.templates.create(userId, hospitalId, dto)
  }

  @Delete(':id')
  @HttpCode(200)
  remove(
    @CurrentUser('id') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Param('id') id: string,
  ) {
    return this.templates.remove(userId, hospitalId, id)
  }
}
