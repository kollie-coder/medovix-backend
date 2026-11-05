import { RequestContextMiddleware } from './common/request-context'
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_GUARD, APP_PIPE } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
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
import { LoggingMiddleware } from './common/middleware/logging.middleware'
import { SuperAdminModule } from './super-admin/super-admin.module'
import { HospitalAdminModule } from './hospital-admin/hospital-admin.module'
import { ClinicalModule } from './clinical/clinical.module'
import { LabModule } from './lab/lab.module'
import { PharmacyModule } from './pharmacy/pharmacy.module'
import { InboxModule } from './inbox/inbox.module'
import { DocumentsModule } from './documents/documents.module'
import { SchedulingModule } from './scheduling/scheduling.module'
import { BillingModule } from './billing/billing.module'
import { NoteTemplatesModule } from './note-templates/note-templates.module'
import { StaffMessagesModule } from './staff-messages/staff-messages.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Default limit for every route: 120 requests per minute per IP.
    // Sensitive routes override this with @Throttle() (see auth.controller.ts).
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
    }),
    PrismaModule,
    AuthModule,
    HospitalsModule,
    RemindersModule,
    NotificationPreferencesModule,
    DietaryModule,
    PushTokensModule,
    NotificationsModule,
    SuperAdminModule,
    HospitalAdminModule,
    ClinicalModule,
    LabModule,
    PharmacyModule,
    InboxModule,
    DocumentsModule,
    SchedulingModule,
    BillingModule,
    NoteTemplatesModule,
    StaffMessagesModule
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, transform: true }),
    },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggingMiddleware, RequestContextMiddleware).forRoutes('*')
  }
}