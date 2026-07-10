import { Test, TestingModule } from '@nestjs/testing';
import { PushTokensController } from './push-tokens.controller';

describe('PushTokensController', () => {
  let controller: PushTokensController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushTokensController],
    }).compile();

    controller = module.get<PushTokensController>(PushTokensController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
