import { Module } from '@nestjs/common'
import { RemindersService } from './reminders.service'
import { RemindersController } from './reminders.controller'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [AuthModule],
  controllers: [RemindersController],
  providers: [RemindersService],
})
export class RemindersModule {}