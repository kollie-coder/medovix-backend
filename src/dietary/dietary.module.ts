import { Module } from '@nestjs/common'
import { DietaryService } from './dietary.service'
import { DietaryController } from './dietary.controller'
import { AuthModule } from '../auth/auth.module'
import { DietAccessGuard } from '../common/diet-access.guard'

@Module({
  imports: [AuthModule],
  controllers: [DietaryController],
  providers: [DietaryService, DietAccessGuard],
  exports: [DietaryService],
})
export class DietaryModule {}