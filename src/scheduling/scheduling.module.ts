import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { SchedulingController } from './scheduling.controller'
import { SchedulingService } from './scheduling.service'

@Module({
  imports: [PrismaModule],
  controllers: [SchedulingController],
  providers: [SchedulingService],
})
export class SchedulingModule {}
