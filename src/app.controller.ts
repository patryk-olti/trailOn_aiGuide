import { Controller, Get } from '@nestjs/common';

interface RootStatus {
  status: 'success';
  version: string;
}

@Controller()
export class AppController {
  @Get()
  root(): RootStatus {
    return {
      status: 'success',
      version: '1.0.1',
    };
  }
}
