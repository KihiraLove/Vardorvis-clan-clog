/** Per-adapter budgets cover the entire interaction, including identical HTTP retries. */
import { WorkBudget } from '@clog/domain';
export const searchRetryChoice = 'clog:retry-search';
export function readWorkloadLimits(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, max: number) => {
    const text = env[name];
    if (text === undefined || text === '') return fallback;
    if (!/^[1-9]\d*$/u.test(text) || Number(text) > max)
      throw new Error(name + ' exceeds its workload limit');
    return Number(text);
  };
  return {
    intakeUser: integer('BOT_INTAKE_USER_PER_MINUTE', 5, 120),
    intakeGuild: integer('BOT_INTAKE_GUILD_PER_MINUTE', 60, 120),
    searchUser: integer('BOT_SEARCH_USER_PER_MINUTE', 30, 600),
    searchGuild: integer('BOT_SEARCH_GUILD_PER_MINUTE', 300, 600),
  };
}
export class BotWorkloads {
  readonly intake: WorkBudget;
  readonly search: WorkBudget;
  constructor(
    limits = readWorkloadLimits({}),
    clock = Date.now,
    maxKeys = 512,
  ) {
    this.intake = new WorkBudget(
      { concurrent: 8, perMinute: 120 },
      [
        { concurrent: 4, perMinute: limits.intakeGuild },
        { concurrent: 1, perMinute: limits.intakeUser },
      ],
      maxKeys,
      clock,
    );
    this.search = new WorkBudget(
      { concurrent: 16, perMinute: 600 },
      [
        { concurrent: 8, perMinute: limits.searchGuild },
        { concurrent: 2, perMinute: limits.searchUser },
      ],
      maxKeys,
      clock,
    );
  }
  close() {
    this.intake.close();
    this.search.close();
  }
}
