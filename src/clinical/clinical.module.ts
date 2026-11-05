import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { ClinicalController } from './clinical.controller'
import { ClinicalService } from './clinical.service'

@Module({
  imports: [PrismaModule],
  controllers: [ClinicalController],
  providers: [ClinicalService],
})
export class ClinicalModule {}