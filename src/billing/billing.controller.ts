import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { Role } from '@prisma/client'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { HospitalScopeGuard } from '../auth/guards/hospital-scope.guard'
import { Roles } from '../auth/decorators/roles.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { BillingService } from './billing.service'
import { CreateInvoiceDto, CreatePriceDto, PaymentDto, ReasonDto, UpdatePriceDto } from './billing.dto'

// Invoices, payments and the price list: for the accountant and the hospital admin.
@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard, HospitalScopeGuard)
@Roles(Role.ACCOUNTANT, Role.ADMIN)
export class BillingController {
  constructor(private billing: BillingService) {}

  @Get('invoices')
  list(
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('filter') filter?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
  ) {
    return this.billing.list(hospitalId, filter ?? 'all', search, page ? parseInt(page, 10) : 1)
  }

  @Post('invoices')
  create(@CurrentUser('hospitalId') hospitalId: string, @CurrentUser('id') userId: string, @Body() dto: CreateInvoiceDto) {
    return this.billing.create(hospitalId, userId, dto)
  }

  @Get('invoices/:id')
  get(@CurrentUser('hospitalId') hospitalId: string, @Param('id') id: string) {
    return this.billing.get(hospitalId, id)
  }

  @Get('invoices/:id/print')
  printInvoice(@CurrentUser('hospitalId') hospitalId: string, @CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.billing.invoicePrintable(hospitalId, userId, id)
  }

  @Post('invoices/:id/payments')
  pay(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: PaymentDto,
  ) {
    return this.billing.recordPayment(hospitalId, userId, id, dto)
  }

  @Post('invoices/:id/payments/:paymentId/reverse')
  reverse(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() dto: ReasonDto,
  ) {
    return this.billing.reversePayment(hospitalId, userId, id, paymentId, dto.reason)
  }

  @Post('invoices/:id/cancel')
  cancel(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.billing.cancel(hospitalId, userId, id, dto.reason)
  }

  @Get('payments/:id/receipt')
  receipt(@CurrentUser('hospitalId') hospitalId: string, @CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.billing.receiptPrintable(hospitalId, userId, id)
  }

  @Get('summary')
  summary(@CurrentUser('hospitalId') hospitalId: string, @Query('from') from: string, @Query('to') to: string) {
    return this.billing.summary(hospitalId, from, to)
  }

  @Get('unbilled')
  unbilled(@CurrentUser('hospitalId') hospitalId: string) {
    return this.billing.unbilled(hospitalId)
  }

  @Get('visits/:appointmentId/suggestions')
  suggestions(@CurrentUser('hospitalId') hospitalId: string, @Param('appointmentId') appointmentId: string) {
    return this.billing.suggestions(hospitalId, appointmentId)
  }

  @Get('patients')
  patients(@CurrentUser('hospitalId') hospitalId: string, @Query('search') search?: string) {
    return this.billing.searchPatients(hospitalId, search ?? '')
  }

  @Get('prices')
  prices(@CurrentUser('hospitalId') hospitalId: string) {
    return this.billing.listPrices(hospitalId)
  }

  @Post('prices')
  createPrice(@CurrentUser('hospitalId') hospitalId: string, @CurrentUser('id') userId: string, @Body() dto: CreatePriceDto) {
    return this.billing.createPrice(hospitalId, userId, dto)
  }

  @Patch('prices/:id')
  updatePrice(
    @CurrentUser('hospitalId') hospitalId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePriceDto,
  ) {
    return this.billing.updatePrice(hospitalId, userId, id, dto)
  }
}
