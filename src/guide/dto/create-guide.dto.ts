import { Type } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { GuideLocationDto } from './guide-location.dto';

export class CreateGuideDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  participantId!: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  context?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GuideLocationDto)
  location?: GuideLocationDto;
}
