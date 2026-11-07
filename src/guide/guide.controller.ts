import { Body, Controller, Post } from '@nestjs/common';
import { CreateGuideDto } from './dto/create-guide.dto';
import { GuideService } from './guide.service';
import { GuideReply } from './guide.types';

@Controller('guide')
export class GuideController {
  constructor(private readonly guideService: GuideService) {}

  @Post()
  create(@Body() dto: CreateGuideDto): Promise<GuideReply> {
    return this.guideService.reply(dto);
  }
}
