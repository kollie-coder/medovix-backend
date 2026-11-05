import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { PharmacyController } from './pharmacy.controller'
import { PharmacyService } from './pharmacy.service'

@Module({
  imports: [PrismaModule],
  controllers: [PharmacyController],
  providers: [PharmacyService],
})
export class PharmacyModule {}
