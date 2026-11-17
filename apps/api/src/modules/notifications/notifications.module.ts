import {
  Body,
  Controller,
  Get,
  Global,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { NotificationMailService } from './notification-mail.service';
import {
  NotificationPreferencesDto,
  NotificationSmtpDto,
  NotificationsQuery,
  NotificationSubscriptionsDto,
  VerifyNotificationEmailDto,
} from './notification.types';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly mail: NotificationMailService,
  ) {}

  @Get()
  list(@Req() request: AuthRequest, @Query() query: NotificationsQuery) {
    return this.notifications.list(request.user.id, query);
  }

  @Get('unread-count')
  unreadCount(@Req() request: AuthRequest) {
    return this.notifications.unreadCount(request.user.id);
  }

  @Patch('read-all')
  readAll(@Req() request: AuthRequest) {
    return this.notifications.markRead(request.user.id);
  }

  @Patch(':id/read')
  read(@Param('id', ParseUUIDPipe) id: string, @Req() request: AuthRequest) {
    return this.notifications.markRead(request.user.id, id);
  }

  @Get('preferences')
  preferences(@Req() request: AuthRequest) {
    return this.notifications.preferences(request.user.id);
  }

  @Put('preferences')
  savePreferences(@Req() request: AuthRequest, @Body() input: NotificationPreferencesDto) {
    return this.notifications.savePreferences(request.user.id, input);
  }

  @Post('email/verify-request')
  requestVerification(@Req() request: AuthRequest) {
    return this.notifications.requestVerification(request.user.id);
  }

  @Post('email/verify-confirm')
  confirmVerification(@Req() request: AuthRequest, @Body() input: VerifyNotificationEmailDto) {
    return this.notifications.confirmVerification(request.user.id, input.code);
  }

  @Get('subscriptions')
  subscriptions(@Req() request: AuthRequest) {
    return this.notifications.subscriptions(request.user.id);
  }

  @Put('subscriptions')
  saveSubscriptions(@Req() request: AuthRequest, @Body() input: NotificationSubscriptionsDto) {
    return this.notifications.saveSubscriptions(request.user.id, input.subscriptions);
  }

  @Get('smtp')
  @Roles('ADMIN')
  smtp() {
    return this.mail.config();
  }

  @Put('smtp')
  @Roles('ADMIN')
  configureSmtp(@Req() request: AuthRequest, @Body() input: NotificationSmtpDto) {
    return this.mail.configure(input, request.user.id);
  }

  @Post('smtp/test')
  @Roles('ADMIN')
  testSmtp() {
    return this.mail.verifySmtp();
  }
}

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationMailService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
