import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { StaffMessagesController } from './staff-messages.controller'
import { StaffMessagesService } from './staff-messages.service'

@Module({
  imports: [PrismaModule],
  controllers: [StaffMessagesController],
  providers: [StaffMessagesService],
})
export class StaffMessagesModule {}
