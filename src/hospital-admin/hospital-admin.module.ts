import { Module } from '@nestjs/common'
import { HospitalAdminService } from './hospital-admin.service'
import { HospitalAdminController } from './hospital-admin.controller'
import { AuthModule } from '../auth/auth.module'
import { EmailModule } from 'src/email/email.module'
import { PrismaModule } from 'src/prisma/prisma.module'
import { StorageModule } from 'src/storage/storage.module'

@Module({
  imports: [AuthModule, EmailModule, PrismaModule, StorageModule],
  controllers: [HospitalAdminController],
  providers: [HospitalAdminService],
})
export class HospitalAdminModule {}