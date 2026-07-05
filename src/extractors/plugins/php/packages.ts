import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Composer package recognition (PHP). Plugin-owned. */
export const composerPackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["laravel/framework"], category: "framework", framework: { id: "laravel", name: "Laravel" } },
  { names: ["symfony/framework-bundle", "symfony/symfony"], category: "framework", framework: { id: "symfony", name: "Symfony" } },
  { names: ["slim/slim"], category: "framework", framework: { id: "slim", name: "Slim" } },
  { names: ["cakephp/cakephp"], category: "framework", framework: { id: "cakephp", name: "CakePHP" } },
  { names: ["yiisoft/yii2"], category: "framework", framework: { id: "yii", name: "Yii" } },
  { names: ["codeigniter4/framework"], category: "framework", framework: { id: "codeigniter", name: "CodeIgniter" } },
  // ── ORM ──
  { names: ["doctrine/orm", "doctrine/dbal", "illuminate/database"], category: "orm" },
  // ── Messaging ──
  { names: ["php-amqplib/php-amqplib", "enqueue/amqp-lib"], category: "messaging", framework: { id: "rabbitmq", name: "RabbitMQ" } },
  // ── HTTP ──
  { names: ["guzzlehttp/guzzle"], category: "http" },
  // ── Testing ──
  { names: ["phpunit/phpunit", "mockery/mockery"], category: "testing" },
];
