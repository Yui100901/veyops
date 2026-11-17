import { Module } from '@nestjs/common';
import { CommandCenterController } from './command-center.controller';
import { CommandCenterService } from './command-center.service';
import { TargetResolver } from './target-resolver.service';
import { CommandTemplatesController } from './command-templates.controller';
import { CommandTemplatesService } from './command-templates.service';

@Module({
  controllers: [CommandCenterController, CommandTemplatesController],
  providers: [CommandCenterService, CommandTemplatesService, TargetResolver],
  exports: [TargetResolver, CommandCenterService, CommandTemplatesService],
})
export class CommandCenterModule {}
