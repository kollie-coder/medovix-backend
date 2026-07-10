import { Test, TestingModule } from '@nestjs/testing';
import { PushTokensService } from './push-tokens.service';

describe('PushTokensService', () => {
  let service: PushTokensService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PushTokensService],
    }).compile();

    service = module.get<PushTokensService>(PushTokensService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
