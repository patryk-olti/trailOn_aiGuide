import { Module } from '@nestjs/common';
import { OpenAiModule } from '../openai/openai.module';
import { GuideController } from './guide.controller';
import { GuideService } from './guide.service';

@Module({
  imports: [OpenAiModule],
  controllers: [GuideController],
  providers: [GuideService],
})
export class GuideModule {}
