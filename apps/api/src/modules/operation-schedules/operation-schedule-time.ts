import { BadRequestException } from '@nestjs/common';
import { CronExpressionParser } from 'cron-parser';

export type ScheduleTiming =
  | { type: 'ONCE'; timeZone: string; runAt: number }
  | { type: 'INTERVAL'; timeZone: string; intervalSeconds: number }
  | { type: 'CRON'; timeZone: string; cron: string };

const dayMilliseconds = 24 * 60 * 60 * 1000;

export function normalizeScheduleTiming(input: {
  type: ScheduleTiming['type'];
  timeZone?: string;
  runAt?: number;
  intervalSeconds?: number;
  cron?: string;
}): ScheduleTiming {
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    if (/^[+-]/.test(timeZone)) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw new BadRequestException('请填写有效的 IANA 时区');
  }
  if (input.type === 'ONCE') {
    const runAt = input.runAt;
    if (!runAt || !Number.isSafeInteger(runAt) || runAt < 0 || runAt > 8.64e15)
      throw new BadRequestException('请输入有效的单次执行时间');
    return { type: input.type, timeZone, runAt };
  }
  if (input.type === 'INTERVAL') {
    const intervalSeconds = input.intervalSeconds;
    if (
      !intervalSeconds ||
      !Number.isInteger(intervalSeconds) ||
      intervalSeconds < 1 ||
      intervalSeconds > 31_536_000
    )
      throw new BadRequestException('请输入 1 秒到 365 天之间的执行间隔');
    return { type: input.type, timeZone, intervalSeconds };
  }
  const words = (input.cron ?? '').trim().toUpperCase().split(/\s+/);
  const syntax = [...words];
  if (words.length === 5) {
    syntax[3] = syntax[3].replace(/\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/g, '1');
    syntax[4] = syntax[4].replace(/\b(?:SUN|MON|TUE|WED|THU|FRI|SAT)\b/g, '1');
  }
  if (words.length !== 5 || syntax.some((word) => !/^[0-9*,/-]+$/.test(word)))
    throw new BadRequestException('请输入五字段 Cron，支持列表、范围和步长');
  return { type: 'CRON', timeZone, cron: words.join(' ') };
}

function cronNext(timing: Extract<ScheduleTiming, { type: 'CRON' }>, after: number, count: number) {
  try {
    const parser = CronExpressionParser.parse(timing.cron, {
      tz: timing.timeZone,
      currentDate: new Date(after),
    });
    const fields = parser.fields;
    const formatter = new Intl.DateTimeFormat('en', {
      timeZone: timing.timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    const wallTime = (at: number) => {
      const local = Object.fromEntries(
        formatter.formatToParts(at).map(({ type, value }) => [type, Number(value)]),
      );
      return new Date(
        Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second),
      );
    };
    const upcoming: number[] = [];
    for (let attempt = 0; upcoming.length < count && attempt < count + 1500; attempt++) {
      const at = parser.next().getTime();
      const wall = wallTime(at);
      const dayMatches = fields.dayOfMonth.values.some((value) => value === wall.getUTCDate());
      const weekdayMatches = fields.dayOfWeek.values.some((value) => value === wall.getUTCDay());
      const dateMatches =
        fields.dayOfMonth.isWildcard || fields.dayOfWeek.isWildcard
          ? dayMatches && weekdayMatches
          : dayMatches || weekdayMatches;
      // Ignore a candidate shifted past a nonexistent wall time by the parser.
      if (
        !dateMatches ||
        !fields.month.values.some((value) => value === wall.getUTCMonth() + 1) ||
        !fields.hour.values.some((value) => value === wall.getUTCHours()) ||
        !fields.minute.values.some((value) => value === wall.getUTCMinutes())
      )
        continue;
      // Detect the second occurrence even when iteration starts in the middle of the repeated hour.
      const yesterday = at - dayMilliseconds;
      const offsetChange = wallTime(yesterday).getTime() - yesterday - (wall.getTime() - at);
      if (offsetChange > 0 && wallTime(at - offsetChange).getTime() === wall.getTime()) continue;
      upcoming.push(at);
    }
    if (upcoming.length < count) throw new Error('No upcoming valid occurrences');
    return upcoming;
  } catch {
    throw new BadRequestException('Cron 表达式无效或没有可计算的未来执行时间');
  }
}

export function upcomingTimes(
  timing: ScheduleTiming,
  anchor: number,
  after: number,
  count: number,
) {
  if (timing.type === 'ONCE') return timing.runAt > after ? [timing.runAt] : [];
  if (timing.type === 'CRON') return cronNext(timing, after, count);
  const step = timing.intervalSeconds * 1000;
  const first = Math.max(1, Math.floor((after - anchor) / step) + 1);
  return Array.from({ length: count }, (_, index) => anchor + (first + index) * step);
}
