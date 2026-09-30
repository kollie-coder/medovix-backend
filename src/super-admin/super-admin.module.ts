import { Module } from '@nestjs/common'
import { SuperAdminService } from './super-admin.service'
import { SuperAdminController } from './super-admin.controller'
import { AuthModule } from '../auth/auth.module'
import { EmailModule } from 'src/email/email.module'

@Module({
  imports: [AuthModule, EmailModule],
  controllers: [SuperAdminController],
  providers: [SuperAdminService],
})
export class SuperAdminModule {}