import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { LabController } from './lab.controller'
import { LabService } from './lab.service'

@Module({
  imports: [PrismaModule],
  controllers: [LabController],
  providers: [LabService],
})
export class LabModule {}
