import { Module } from '@nestjs/common';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { OpenAiModule } from '../openai/openai.module';
import { RagModule } from '../rag/rag.module';
import { WeatherModule } from '../weather/weather.module';
import { GuideController } from './guide.controller';
import { GuideService } from './guide.service';

@Module({
  imports: [OpenAiModule, CloudflareModule, RagModule, WeatherModule],
  controllers: [GuideController],
  providers: [GuideService],
})
export class GuideModule {}
