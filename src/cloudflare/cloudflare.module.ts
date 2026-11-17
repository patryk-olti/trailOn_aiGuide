import { Module } from '@nestjs/common';
import { D1Service } from './d1.service';
import { R2Service } from './r2.service';

@Module({
  providers: [R2Service, D1Service],
  exports: [R2Service, D1Service],
})
export class CloudflareModule {}