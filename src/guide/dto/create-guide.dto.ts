import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateGuideDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  context?: string;
}
