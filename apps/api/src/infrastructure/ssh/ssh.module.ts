import { Global, Module } from '@nestjs/common';
import { SshService } from './ssh.service';
import { MultiTargetExecutor } from './multi-target.executor';

@Global()
@Module({
  providers: [SshService, MultiTargetExecutor],
  exports: [SshService, MultiTargetExecutor],
})
export class SshModule {}
