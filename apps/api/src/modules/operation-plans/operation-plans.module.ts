import { Module } from '@nestjs/common';
import { CommandCenterModule } from '../command-center/command-center.module';
import { OperationPlansService } from './operation-plans.service';
import { OperationPlansController } from './operation-plans.controller';

@Module({
  imports: [CommandCenterModule],
  controllers: [OperationPlansController],
  providers: [OperationPlansService],
})
export class OperationPlansModule {}
