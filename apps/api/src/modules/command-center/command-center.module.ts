import { Module } from '@nestjs/common';
import { CommandCenterController } from './command-center.controller';
import { CommandCenterService } from './command-center.service';
import { TargetResolver } from './target-resolver.service';

@Module({
  controllers: [CommandCenterController],
  providers: [CommandCenterService, TargetResolver],
  exports: [TargetResolver, CommandCenterService],
})
export class CommandCenterModule {}
