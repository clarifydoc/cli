import { describe, expect, it } from "vitest";
import { extractGoScheduledJobs } from "./scheduled-jobs.js";
import { extractRubyScheduledJobs } from "../ruby/scheduled-jobs.js";
import { extractPhpScheduledJobs } from "../php/scheduled-jobs.js";

const show = (e: { name: string; handler?: string; schedule?: string; framework?: string; line: number }) => `${e.name} → ${e.handler ?? "-"} [${e.schedule ?? ""}] (${e.framework}) @${e.line}`;

describe("scheduled jobs in Go, Ruby and PHP", () => {
  it("Go: robfig/cron and gocron v1/v2", () => {
    const src = [
      `c := cron.New()`,
      `c.AddFunc("0 30 * * * *", syncInventory)`,
      `c.AddFunc("@hourly", func() { log.Println("tick") })`,
      `s.Every(1).Day().At("10:30").Do(sendDigest)`,
      `s.NewJob(gocron.DurationJob(10*time.Second), gocron.NewTask(jobs.Purge, ctx))`,
    ];
    expect(extractGoScheduledJobs(src).map(show)).toEqual([
      "syncInventory → syncInventory [0 30 * * * *] (robfig/cron) @2",
      "@hourly → - [@hourly] (robfig/cron) @3",
      "sendDigest → sendDigest [every 1 day at 10:30] (gocron) @4",
      "Purge → Purge [duration 10*time.Second] (gocron) @5",
    ]);
  });

  it("Ruby: whenever, clockwork and sidekiq-cron", () => {
    const src = [
      `every 1.day, at: "4:30 am" do`,
      `  runner "Report.nightly"`,
      `  rake "cache:warm"`,
      `end`,
      `every(1.hour, "sync") { SyncJob.perform_later }`,
      `Sidekiq::Cron::Job.create(name: "purge", cron: "*/5 * * * *", class: "PurgeWorker")`,
    ];
    expect(extractRubyScheduledJobs(src).map(show)).toEqual([
      "Report.nightly → Report.nightly [every 1.day, at: 4:30 am] (whenever) @2",
      "rake cache:warm → - [every 1.day, at: 4:30 am] (whenever) @3",
      "sync → SyncJob.perform [every 1.hour] (clockwork) @5",
      "purge → PurgeWorker.perform [*/5 * * * *] (sidekiq-cron) @6",
    ]);
  });

  it("PHP: Laravel's scheduler and Symfony's cron tasks", () => {
    const src = `<?php
protected function schedule(Schedule $schedule): void
{
    $schedule->job(new SendReports)->dailyAt('02:00');
    $schedule->command('emails:send')->hourly();
}
Schedule::job(PurgeSessions::class)->everyFiveMinutes();

#[AsCronTask('0 3 * * *')]
final class RebuildIndex { public function __invoke(): void {} }`;
    expect(extractPhpScheduledJobs(src).map(show)).toEqual([
      "SendReports → SendReports.handle [dailyAt('02:00')] (laravel) @4",
      "emails:send → - [hourly] (laravel) @5",
      "PurgeSessions → PurgeSessions.handle [everyFiveMinutes] (laravel) @7",
      "RebuildIndex → RebuildIndex.__invoke [0 3 * * *] (symfony) @9",
    ]);
  });
});
