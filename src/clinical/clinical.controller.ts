import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { Role } from '@prisma/client'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { HospitalScopeGuard } from '../auth/guards/hospital-scope.guard'
import { Roles } from '../auth/decorators/roles.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { ClinicalService } from './clinical.service'
import {
  AddendumDto, ConsultationDto, LabOrdersDto, PrescriptionDto, VitalsDto,
} from './dto/clinical.dto'

const CLINICIANS: Role[] = [Role.DOCTOR, Role.NURSE]

// Clinical routes are for doctors (and nurses, for vitals only). Hospital
// administrators manage the hospital but do not read patient charts here.
@Controller('clinical')
@UseGuards(JwtAuthGuard, RolesGuard, HospitalScopeGuard)
@Roles(Role.DOCTOR)
export class ClinicalController {
  constructor(private clinical: ClinicalService) {}

  @Get('queue')
  queue(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.clinical.doctorQueue(hospitalId, doctorId, from, to)
  }

  @Get('nurse-queue')
  @Roles(Role.NURSE, Role.DOCTOR)
  nurseQueue(
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.clinical.nurseQueue(hospitalId, from, to)
  }

  @Get('appointments/:id')
  visit(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
  ) {
    return this.clinical.getVisit(hospitalId, doctorId, id)
  }

  @Post('appointments/:id/start')
  @HttpCode(200)
  start(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
  ) {
    return this.clinical.startVisit(hospitalId, doctorId, id)
  }

  @Post('appointments/:id/complete')
  @HttpCode(200)
  complete(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
  ) {
    return this.clinical.completeVisit(hospitalId, doctorId, id)
  }

  @Get('patients')
  searchPatients(
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('search') search?: string,
  ) {
    return this.clinical.searchPatients(hospitalId, search ?? '')
  }

  @Get('patients/:patientId/chart')
  chart(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('patientId') patientId: string,
  ) {
    return this.clinical.getChart(hospitalId, doctorId, patientId)
  }

  @Get('patients/:patientId/records')
  records(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('patientId') patientId: string,
    @Query('page') page?: string,
  ) {
    return this.clinical.getPatientRecords(hospitalId, doctorId, patientId, page ? Number(page) : 1)
  }

  @Post('appointments/:id/vitals')
  @Roles(...CLINICIANS)
  vitals(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') role: Role,
    @Param('id') id: string,
    @Body() dto: VitalsDto,
  ) {
    return this.clinical.recordVitals(hospitalId, { id: actorId, role }, id, dto)
  }

  @Post('appointments/:id/consultation')
  consultation(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
    @Body() dto: ConsultationDto,
  ) {
    return this.clinical.recordConsultation(hospitalId, doctorId, id, dto)
  }

  @Post('appointments/:id/addendum')
  addendum(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
    @Body() dto: AddendumDto,
  ) {
    return this.clinical.addAddendum(hospitalId, doctorId, id, dto)
  }

  @Post('appointments/:id/prescriptions')
  prescribe(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
    @Body() dto: PrescriptionDto,
  ) {
    return this.clinical.prescribe(hospitalId, doctorId, id, dto)
  }

  @Post('appointments/:id/lab-orders')
  labOrders(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') doctorId: string,
    @Param('id') id: string,
    @Body() dto: LabOrdersDto,
  ) {
    return this.clinical.orderLabTests(hospitalId, doctorId, id, dto)
  }
}