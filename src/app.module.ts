import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_PIPE } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { PrismaModule } from './prisma/prisma.module'
import { AuthModule } from './auth/auth.module'
import { HospitalsModule } from './hospitals/hospitals.module';
import { RemindersModule } from './reminders/reminders.module';
import { PushTokensModule } from './push-tokens/push-tokens.module';
import { DietaryModule } from './dietary/dietary.module'
import { NotificationPreferencesModule } from './notification-preferences/notification-preferences.module'
import { NotificationsModule } from './notifications/notifications.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    HospitalsModule,
    RemindersModule,
    NotificationPreferencesModule,
    DietaryModule,
    PushTokensModule,
    NotificationsModule
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, transform: true }),
    },
  ],
})
export class AppModule {}