/** Randomly salted scrypt with one bounded queue for every authentication path. */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { WorkloadError } from '@clog/domain';

// About 32 MiB per active derive; preserve the existing verifier/work factor.
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });

type Job = {
  start: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class PasswordHasher {
  private active = 0;
  private readonly queue: Job[] = [];
  private stopped = false;
  private readonly drained: (() => void)[] = [];
  constructor(
    private readonly limits = { concurrent: 2, queued: 4, waitMs: 1000 },
    private readonly compute = derive,
  ) {
    if (
      !Number.isInteger(limits.concurrent) ||
      limits.concurrent < 1 ||
      limits.concurrent > 2 ||
      !Number.isInteger(limits.queued) ||
      limits.queued < 0 ||
      limits.queued > 4 ||
      !Number.isInteger(limits.waitMs) ||
      limits.waitMs < 1 ||
      limits.waitMs > 1000
    )
      throw new Error('Invalid password work budget');
  }
  private run(password: string, salt: Buffer): Promise<Buffer> {
    if (
      this.stopped ||
      (this.active >= this.limits.concurrent &&
        this.queue.length >= this.limits.queued)
    )
      return Promise.reject(new WorkloadError());
    return new Promise((resolve, reject) => {
      const start = () => {
        this.active++;
        void this.compute(password, salt)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            const job = this.queue.shift();
            if (job) {
              clearTimeout(job.timer);
              job.start();
            }
            if (!this.active) for (const done of this.drained.splice(0)) done();
          });
      };
      if (this.active < this.limits.concurrent) {
        start();
        return;
      }
      const job: Job = {
        start,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(job);
          if (index !== -1) this.queue.splice(index, 1);
          reject(new WorkloadError());
        }, this.limits.waitMs),
      };
      this.queue.push(job);
    });
  }
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16),
      value = await this.run(password, salt);
    return `scrypt$32768$8$3$${salt.toString('hex')}$${value.toString('hex')}`;
  }
  async verify(password: string, encoded: string) {
    const match =
      /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/u.exec(encoded);
    if (!match) return false;
    const value = await this.run(password, Buffer.from(match[1]!, 'hex'));
    return timingSafeEqual(value, Buffer.from(match[2]!, 'hex'));
  }
  close(): Promise<void> {
    this.stopped = true;
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.timer);
      job.reject(new WorkloadError());
    }
    return this.active
      ? new Promise((resolve) => this.drained.push(resolve))
      : Promise.resolve();
  }
  snapshot() {
    return {
      active: this.active,
      queued: this.queue.length,
      stopped: this.stopped,
    };
  }
}
const defaults = new PasswordHasher();
export const hashPassword = (password: string) => defaults.hash(password);
export const verifyPassword = (password: string, encoded: string) =>
  defaults.verify(password, encoded);
