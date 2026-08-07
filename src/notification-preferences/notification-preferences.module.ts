import { Module } from '@nestjs/common'
import { NotificationPreferencesService } from './notification-preferences.service'
import { NotificationPreferencesController } from './notification-preferences.controller'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [AuthModule],
  controllers: [NotificationPreferencesController],
  providers: [NotificationPreferencesService],
  exports: [NotificationPreferencesService],
})
export class NotificationPreferencesModule {}