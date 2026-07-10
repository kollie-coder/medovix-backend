import { Module } from '@nestjs/common';
import { PushTokensController } from './push-tokens.controller';
import { PushTokensService } from './push-tokens.service';

@Module({
  controllers: [PushTokensController],
  providers: [PushTokensService]
})
export class PushTokensModule {}
