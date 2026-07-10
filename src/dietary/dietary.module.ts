import { Module } from '@nestjs/common'
import { DietaryService } from './dietary.service'
import { DietaryController } from './dietary.controller'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [AuthModule],
  controllers: [DietaryController],
  providers: [DietaryService],
  exports: [DietaryService],
})
export class DietaryModule {}