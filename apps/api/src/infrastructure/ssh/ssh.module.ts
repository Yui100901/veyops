import { Global, Module } from '@nestjs/common';
import { SshService } from './ssh.service';
import { MultiTargetExecutor } from './multi-target.executor';
import { InteractiveCommandInputs } from './interactive-command-inputs';

@Global()
@Module({
  providers: [SshService, MultiTargetExecutor, InteractiveCommandInputs],
  exports: [SshService, MultiTargetExecutor, InteractiveCommandInputs],
})
export class SshModule {}
