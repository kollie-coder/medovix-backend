import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import { Role } from '@prisma/client'
import { Throttle } from '@nestjs/throttler'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { HospitalScopeGuard } from '../auth/guards/hospital-scope.guard'
import { Roles } from '../auth/decorators/roles.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { DocumentsService } from './documents.service'
import { ReferralDto, SickNoteDto } from './documents.dto'

// Sick notes, referral letters and printable prescriptions, for doctors.
@Controller('documents')
@UseGuards(JwtAuthGuard, RolesGuard, HospitalScopeGuard)
@Roles(Role.DOCTOR)
export class DocumentsController {
  constructor(private documents: DocumentsService) {}

  @Post('appointments/:id/sick-note')
  sickNote(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
    @Body() dto: SickNoteDto,
  ) {
    return this.documents.createSickNote(hospitalId, doctorId, id, dto)
  }

  @Post('appointments/:id/referral')
  referral(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
    @Body() dto: ReferralDto,
  ) {
    return this.documents.createReferral(hospitalId, doctorId, id, dto)
  }

  @Get('appointments/:id')
  forVisit(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
  ) {
    return this.documents.listForVisit(hospitalId, doctorId, id)
  }

  @Get('appointments/:id/prescriptions/print')
  visitPrescriptions(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
  ) {
    return this.documents.getVisitPrescriptionsPrintable(hospitalId, doctorId, id)
  }

  @Get('prescriptions/:id/print')
  prescription(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
  ) {
    return this.documents.getPrescriptionPrintable(hospitalId, doctorId, id)
  }

  @Get(':id/print')
  print(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
  ) {
    return this.documents.getPrintable(hospitalId, doctorId, id)
  }
}

// Public: anyone holding a printed letter can check it is genuine.
@Controller('verify')
export class VerifyController {
  constructor(private documents: DocumentsService) {}

  @Get(':reference')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  verify(@Param('reference') reference: string) {
    return this.documents.verify(reference)
  }
}
