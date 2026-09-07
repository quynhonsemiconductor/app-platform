import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { JobMetrics, withJobContext } from '@quynhonsemiconductor/observability';

/**
 * ExclusiveJob — run a scheduled job on exactly one pod, with a correlation id and
 * duration/outcome metrics.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@Cron` and `@Interval` fire on EVERY replica. With one worker task that is invisible;
 * the moment a rolling deploy overlaps two tasks, or the worker scales past one, every job
 * runs twice concurrently. That is not academic here: `audit-cleanup` deletes rows and
 * `storage-cleanup` deletes objects. `@Interval` is the worse of the two, because interval
 * timers start when the pod starts and therefore drift independently — two pods never even
 * collide predictably enough to notice in a log.
 *
 * A SERVICE, NOT A COPIED BLOCK: the lock/log/finally/metrics sequence is identical for
 * every job, and there are eight of them. Inlining it would be eight chances to forget the
 * `finally` and leave a lock held for its whole TTL.
 *
 * FAILS OPEN WHEN THERE IS NO CACHE — deliberately, and this is the one place this differs
 * from the shape it was ported from. `CacheService.acquireLock` returns `false` both when
 * another pod holds the lock AND when there is no cache client at all, so treating a false
 * as "someone else has it" means a Valkey outage silently stops every scheduled job in the
 * system while logging that another pod is doing the work. Losing SLA-breach detection for
 * the length of a cache incident is far worse than running a sweep twice, and every job
 * behind this helper is idempotent (deletes filter on age or orphan status, syncs re-read
 * from the source). So: no cache means no leader election is POSSIBLE, and the job runs.
 */
@Injectable()
export class ExclusiveJob {
  private readonly logger = new Logger(ExclusiveJob.name);

  /**
   * Constructed directly rather than injected, matching `AbstractOutboxRelay`. The OTel
   * instruments are process-global (the same name returns the same instrument) and
   * JobMetrics has no dependencies, so there is nothing for DI to provide.
   */
  private readonly jobMetrics = new JobMetrics();

  /**
   * In-process overlap guard, held alongside the distributed lock rather than instead of it.
   * The two cover different failures: the cache lock stops a SECOND POD starting the job,
   * this stops THIS pod starting a second run when the previous one is still going. It also
   * remains the only guard on the fail-open path below, where there is no cache to lock in.
   */
  private readonly running = new Set<string>();

  constructor(private readonly cache: CacheService) {}

  /**
   * Run `fn` under a cluster-wide lock named after the job.
   *
   * @param name       Job name. Becomes the lock key, the metric label and the log
   *                   correlation scope, so it must be stable — renaming it mid-deploy
   *                   means two differently-named locks and no mutual exclusion.
   * @param lockTtlMs  Lock lifetime. Set it just UNDER the schedule interval: long enough
   *                   that a slow run keeps its lock, short enough that a pod killed
   *                   mid-run does not block the next tick. The lock auto-expires, so a
   *                   crash can never deadlock the job permanently.
   */
  async run(name: string, lockTtlMs: number, fn: () => Promise<void>): Promise<void> {
    if (this.running.has(name)) {
      this.logger.warn(`${name} still running from a previous tick on this pod — skipping`);
      return;
    }
    this.running.add(name);
    try {
      // withJobContext gives the run a correlationId — scheduled work has no request to
      // inherit one from, so without this every line a job logs is unattributable.
      await withJobContext(name, () =>
        this.jobMetrics.time(name, () => this.runExclusively(name, lockTtlMs, fn)),
      );
    } finally {
      this.running.delete(name);
    }
  }

  private async runExclusively(name: string, lockTtlMs: number, fn: () => Promise<void>) {
    if (!this.cache.isAvailable) {
      this.logger.warn(
        `Cache unavailable — running ${name} WITHOUT a leader lock. Safe on a single ` +
          `replica; concurrent runs are possible if more than one is up.`,
      );
      await fn();
      return;
    }

    const key = `cron:${name}`;
    if (!(await this.cache.acquireLock(key, lockTtlMs))) {
      this.logger.log(`${name} already running on another pod — skipping this tick`);
      return;
    }

    try {
      await fn();
    } finally {
      // In `finally` so a throwing job releases its lock rather than blocking every tick
      // until the TTL expires.
      await this.cache.releaseLock(key);
    }
  }
}
